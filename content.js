// 公開版預設關閉詳細 log，避免洗版使用者的 Console。除錯時可手動改成 true。
const DEBUG_MODE = false;
function debugLog(...args) {
    if (DEBUG_MODE) console.log(...args);
}

debugLog("[YT Bilingual Subtitles] Content script loaded. Awaiting timedtext intercepts...");

let captionContainer = null;
let isEnabled = true;

// ===== 分段翻譯排程設定 =====
// 依「字幕行數」切段而不是依影片時長：翻譯等待時間取決於送給 LLM 的行數，
// 與影片長短無關，固定行數能讓長影片與短影片都有一致的等待體驗。
const FIRST_SEGMENT_LINES = 20;        // 首段特別小，讓第一次翻譯最快完成、影片盡早恢復播放
const SEGMENT_LINES = 50;              // 其後每段的行數（低於 background.js 的 100 行批次上限，一次 API 呼叫即可翻完）
const PREFETCH_AHEAD = 2;             // 播放中持續預先翻譯領先幾段
const MAX_CONCURRENT_TRANSLATIONS = 2; // 同時最多幾段在翻譯中，避免一次打太多 API 請求

let subtitlesData = [];   // { startMs, endMs, original, chinese } 整部影片的字幕（original 可能是韓文或日文）
let segments = [];        // { startMs, endMs, lineIndices: [], status: 'pending'|'loading'|'done'|'failed' }
let timeUpdateTimer = null;
let currentActiveSubtitle = null;
let loadingShown = false;
let activeTranslationCount = 0;
let translationQueue = [];
let pendingFirstSegmentVideo = null; // 等待第一段翻完才恢復播放的 video 元素
let lastKnownSegmentForUser = -1;    // 用於偵測使用者是否切換到新的段落（含 seek）
let contextInvalidWarned = false;    // 避免重複印出 extension context invalidated 警告
let failedShown = false;             // 目前是否已顯示「翻譯失敗」提示
let failedSegIdxShown = -1;          // 目前顯示失敗提示的段落索引（用來判斷要不要重畫）

// ===== 字幕顯示設定 =====
// 背板樣式固定為「淡化條紋」（低透明度、不擋畫面），已直接寫在 styles.css 的基本樣式中
let displayMode = 'bilingual';   // 'bilingual'（原文+中文）｜'chineseOnly'（只顯示中文）

// 檢查擴充功能的 background 連線是否還有效。
// 當使用者在 chrome://extensions 重新載入此擴充功能、但 YouTube 分頁沒有重新整理時，
// 舊的 content script 仍會繼續執行，但 chrome.runtime 會變成 undefined，
// 此時不應再嘗試呼叫 chrome.runtime.sendMessage，否則會在 Console 噴出例外。
function isExtensionContextValid() {
    try {
        return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

// 擴充功能連線失效時，停止所有計時器並提示使用者重新整理頁面
function handleExtensionContextInvalidated() {
    clearInterval(timeUpdateTimer);
    if (!contextInvalidWarned) {
        contextInvalidWarned = true;
        console.warn("[YT Bilingual Subtitles] 偵測到擴充功能已被重新載入，請重新整理此頁面以繼續使用雙語字幕。");
    }
}

// 監聽來自 Popup 的設定變更
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;

    if (changes.isEnabled !== undefined) {
        isEnabled = changes.isEnabled.newValue;
        debugLog("[YT Bilingual Subtitles] Toggle state changed to:", isEnabled);
        applyToggleState();

        if (isEnabled) {
            // 開關打開時，若字幕資料其實已經攔截到了（例如使用者先開了 YT 原生 CC，
            // 此時 isEnabled 還是 false，字幕資料只被存起來但沒有啟動分段翻譯排程），
            // 就直接啟動排程，不需要使用者再切一次 YT 的原生字幕按鈕。
            activateBilingualCaptions();
        } else {
            // 關閉時停止計時器，避免背景持續無意義地檢查
            clearInterval(timeUpdateTimer);
        }
    }

    if (changes.displayMode !== undefined) {
        displayMode = changes.displayMode.newValue || 'bilingual';
        applyDisplaySettings();
    }
});

// 依目前的 displayMode 設定，套用對應的 CSS class 到字幕容器上
function applyDisplaySettings() {
    if (!captionContainer) return;

    captionContainer.classList.toggle('chinese-only', displayMode === 'chineseOnly');
}

// 在「字幕資料已存在但分段排程尚未啟動」的情況下啟動排程；
// 若排程已經啟動過，則只需要重新啟動時間軸監控並確保預先翻譯。
function activateBilingualCaptions() {
    if (subtitlesData.length === 0) return; // 還沒攔截到任何字幕資料，等 handleNewSubtitleTrack 處理即可

    const video = document.querySelector('video');
    if (!video) return;

    if (segments.length === 0) {
        // 排程尚未建立過（可能是因為字幕資料抵達時 isEnabled 還是 false）
        waitForVideoDuration((video, durationMs) => {
            buildSegments(durationMs);
            startTimeTracker(video);

            const currentMs = video.currentTime * 1000;
            const segIdx = getSegmentIndexForTime(currentMs);
            lastKnownSegmentForUser = segIdx;
            prioritizeSegment(segIdx);
            ensurePrefetch(segIdx);
        });
    } else {
        // 排程已存在，只是計時器之前被關閉開關時停掉了，重新啟動即可
        startTimeTracker(video);
        const currentMs = video.currentTime * 1000;
        const segIdx = getSegmentIndexForTime(currentMs);
        ensurePrefetch(segIdx);
    }
}

// 套用開關狀態
function applyToggleState() {
    if (isEnabled) {
        document.body.classList.add('yt-bilingual-active');
        if (captionContainer && currentActiveSubtitle) {
            captionContainer.classList.remove('hidden');
        }
    } else {
        document.body.classList.remove('yt-bilingual-active');
        if (captionContainer) {
            captionContainer.classList.add('hidden');
        }
    }
}

// 建立自訂字幕容器
function createCustomCaptionContainer() {
    debugLog("[YT Bilingual Subtitles] Attempting to create custom container...");
    if (document.querySelector('.custom-dual-captions')) return;

    const container = document.querySelector('.html5-video-player');
    if (!container) return;

    captionContainer = document.createElement('div');
    captionContainer.className = 'custom-dual-captions hidden';

    const originalRow = document.createElement('div');
    originalRow.className = 'caption-original';

    const chineseRow = document.createElement('div');
    chineseRow.className = 'caption-chinese';

    captionContainer.appendChild(originalRow);
    captionContainer.appendChild(chineseRow);

    container.appendChild(captionContainer);

    // 容器剛建立時，立即套用目前的顯示內容/背板樣式設定
    applyDisplaySettings();
}

// 更新畫面上的雙語字幕
function updateCustomCaptions(original, chinese) {
    if (!captionContainer) createCustomCaptionContainer();
    if (!captionContainer) return;

    if (!original || !isEnabled) {
        captionContainer.classList.remove('loading', 'failed');
        captionContainer.classList.add('hidden');
        return;
    }

    captionContainer.classList.remove('loading', 'failed');
    const originalRow = captionContainer.querySelector('.caption-original');
    const chineseRow = captionContainer.querySelector('.caption-chinese');

    originalRow.textContent = original;
    chineseRow.textContent = chinese || '';

    captionContainer.classList.remove('hidden');
}

// 顯示「翻譯中」載入提示（當播放進度超前於翻譯進度時）
function showLoadingIndicator(message) {
    if (!captionContainer) createCustomCaptionContainer();
    if (!captionContainer || !isEnabled) return;

    const originalRow = captionContainer.querySelector('.caption-original');
    const chineseRow = captionContainer.querySelector('.caption-chinese');

    originalRow.textContent = '';
    chineseRow.textContent = message || '雙語字幕翻譯中...';

    captionContainer.classList.remove('failed');
    captionContainer.classList.add('loading');
    captionContainer.classList.remove('hidden');
}

// 顯示「翻譯失敗」提示，並附上重試按鈕，讓使用者可以直接點擊重新翻譯該段
function showFailedIndicator(message, segIdx) {
    if (!captionContainer) createCustomCaptionContainer();
    if (!captionContainer || !isEnabled) return;

    captionContainer.classList.remove('loading');
    captionContainer.classList.add('failed');
    captionContainer.classList.remove('hidden');

    const originalRow = captionContainer.querySelector('.caption-original');
    const chineseRow = captionContainer.querySelector('.caption-chinese');

    originalRow.textContent = '';
    chineseRow.innerHTML = '';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = `翻譯失敗：${message}`;
    chineseRow.appendChild(msgSpan);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = '重試';
    retryBtn.onclick = (e) => {
        e.stopPropagation();
        retrySegment(segIdx);
    };
    chineseRow.appendChild(retryBtn);
}

// 使用者點擊「重試」按鈕：重置該段狀態並重新插隊翻譯
function retrySegment(segIdx) {
    const seg = segments[segIdx];
    if (!seg) return;
    seg.status = 'pending';
    seg.errorMessage = null;
    failedShown = false;
    failedSegIdxShown = -1;
    loadingShown = false;
    prioritizeSegment(segIdx);
}

// 接收 inject.js 攔截到的字幕檔
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'YT_SUBTITLE_INTERCEPT') {
        debugLog("[YT Bilingual Subtitles] Received full subtitle track!");
        handleNewSubtitleTrack(event.data.data, event.data.url);
    }
});

// ===== SPA 換頁處理 =====
// YouTube 切換影片不會重新載入頁面，若新影片沒有韓/日字幕（不會觸發新的攔截與重置），
// 舊影片的字幕資料會殘留並照時間軸顯示在新影片上。因此在導頁完成時主動清空狀態。
let trackVideoId = ''; // 目前字幕資料所屬的影片 ID（取自 timedtext 請求的 v 參數）

function getCurrentVideoId() {
    const shortsMatch = location.pathname.match(/^\/shorts\/([\w-]+)/);
    if (shortsMatch) return shortsMatch[1];
    return new URLSearchParams(location.search).get('v') || '';
}

window.addEventListener('yt-navigate-finish', () => {
    if (subtitlesData.length === 0) return;
    // 新影片的字幕若已搶先一步被攔截到（屬於同一部影片），就不能清掉
    if (trackVideoId && trackVideoId === getCurrentVideoId()) return;
    resetSubtitleState();
});

// 清空上一部影片的字幕資料與排程狀態，並隱藏字幕容器
function resetSubtitleState() {
    debugLog("[YT Bilingual Subtitles] Navigation detected, clearing stale subtitle state.");
    clearInterval(timeUpdateTimer);
    subtitlesData = [];
    segments = [];
    translationQueue = [];
    activeTranslationCount = 0;
    currentActiveSubtitle = null;
    loadingShown = false;
    failedShown = false;
    failedSegIdxShown = -1;
    lastKnownSegmentForUser = -1;
    pendingFirstSegmentVideo = null;
    trackVideoId = '';
    if (captionContainer) {
        captionContainer.classList.remove('loading', 'failed');
        captionContainer.classList.add('hidden');
    }
}

// 解析 YouTube json3 字幕格式，並啟動分段翻譯排程
function handleNewSubtitleTrack(data, sourceUrl) {
    if (!data || !data.events) return;

    const newSubtitles = [];
    data.events.forEach(ev => {
        if (!ev.segs) return;
        const text = ev.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim();
        if (text) {
            newSubtitles.push({
                startMs: ev.tStartMs,
                endMs: ev.tStartMs + (ev.dDurationMs || 3000),
                original: text,
                chinese: null
            });
        }
    });

    if (newSubtitles.length === 0) return;

    // 避免「前一句字幕的顯示視窗(預設 3 秒)蓋過下一句的開始時間」造成字幕延遲出現：
    // 把每一行字幕的結束時間裁切到下一行開始之前。
    for (let i = 0; i < newSubtitles.length - 1; i++) {
        const nextStartMs = newSubtitles[i + 1].startMs;
        if (newSubtitles[i].endMs > nextStartMs) {
            newSubtitles[i].endMs = nextStartMs;
        }
    }

    // 記下這批字幕屬於哪部影片（timedtext 請求的 v 參數），供換頁時判斷是否要清除
    try {
        trackVideoId = new URL(sourceUrl, location.href).searchParams.get('v') || '';
    } catch (e) {
        trackVideoId = '';
    }

    // 新影片或字幕重新載入時，重置所有排程狀態
    clearInterval(timeUpdateTimer);
    subtitlesData = newSubtitles;
    segments = [];
    translationQueue = [];
    activeTranslationCount = 0;
    currentActiveSubtitle = null;
    loadingShown = false;
    lastKnownSegmentForUser = -1;
    pendingFirstSegmentVideo = null;

    if (!isEnabled) {
        // 未啟用雙語字幕時不需要翻譯
        return;
    }

    waitForVideoDuration((video, durationMs) => {
        buildSegments(durationMs);
        startTimeTracker(video);

        // 第一段翻譯完成前先暫停播放，避免使用者看不到翻譯結果
        const wasPlaying = !video.paused;
        if (wasPlaying) {
            video.pause();
            pendingFirstSegmentVideo = video;
        }

        requestSegmentTranslation(0, () => {
            if (pendingFirstSegmentVideo === video) {
                video.play().catch(() => {});
                pendingFirstSegmentVideo = null;
            }
            // 開始播放後，持續在背景預先翻譯接下來的段落
            ensurePrefetch(0);
        });
    });
}

// 等待影片 metadata（duration）就緒
function waitForVideoDuration(callback) {
    const tryGet = () => {
        const video = document.querySelector('video');
        if (video && video.duration && isFinite(video.duration) && video.duration > 0) {
            callback(video, video.duration * 1000);
            return true;
        }
        return false;
    };

    if (tryGet()) return;

    const video = document.querySelector('video');
    const poll = setInterval(() => {
        if (!isExtensionContextValid()) {
            handleExtensionContextInvalidated();
            clearInterval(poll);
            return;
        }
        if (tryGet()) clearInterval(poll);
    }, 300);

    if (video) {
        const onLoadedMeta = () => {
            if (tryGet()) {
                video.removeEventListener('loadedmetadata', onLoadedMeta);
                clearInterval(poll);
            }
        };
        video.addEventListener('loadedmetadata', onLoadedMeta);
    }
}

// 依「字幕行數」將字幕切段：首段較小以縮短起播等待，其後每段固定行數。
// 段落的時間邊界彼此相連（前一段的 endMs = 下一段的 startMs），
// 中間不留空隙，讓 getSegmentIndexForTime 在任何播放時間點都能對應到唯一一段。
function buildSegments(durationMs) {
    segments = [];
    if (subtitlesData.length === 0) return;

    // 先把字幕行的索引分組：第一組 FIRST_SEGMENT_LINES 行，其後每組 SEGMENT_LINES 行
    const groups = [];
    let pos = 0;
    while (pos < subtitlesData.length) {
        const size = (groups.length === 0) ? FIRST_SEGMENT_LINES : SEGMENT_LINES;
        const end = Math.min(pos + size, subtitlesData.length);
        const indices = [];
        for (let i = pos; i < end; i++) {
            indices.push(i);
        }
        groups.push(indices);
        pos = end;
    }

    // 依分組建立段落：每段的 endMs 取「下一組第一行的開始時間」，使段落間無縫相連
    const totalMs = Math.max(durationMs, subtitlesData[subtitlesData.length - 1].endMs);
    for (let g = 0; g < groups.length; g++) {
        segments.push({
            startMs: (g === 0) ? 0 : subtitlesData[groups[g][0]].startMs,
            endMs: (g === groups.length - 1) ? totalMs : subtitlesData[groups[g + 1][0]].startMs,
            lineIndices: groups[g],
            status: 'pending',
            errorMessage: null
        });
    }
}

// 找出某個播放時間點屬於哪一段
function getSegmentIndexForTime(currentMs) {
    for (let i = 0; i < segments.length; i++) {
        if (currentMs >= segments[i].startMs && currentMs < segments[i].endMs) return i;
    }
    return segments.length - 1;
}

// 向 background.js 請求翻譯某一段字幕，完成後把結果填回 subtitlesData
function requestSegmentTranslation(segIdx, onDone) {
    if (segIdx < 0 || segIdx >= segments.length) return;
    if (!isExtensionContextValid()) {
        handleExtensionContextInvalidated();
        return;
    }
    const seg = segments[segIdx];

    if (seg.status === 'done') {
        if (onDone) onDone();
        return;
    }
    if (seg.status === 'loading') {
        return; // 已經在翻譯中，不要重複送出
    }
    if (seg.lineIndices.length === 0) {
        seg.status = 'done';
        if (onDone) onDone();
        return;
    }

    seg.status = 'loading';
    activeTranslationCount++;
    const texts = seg.lineIndices.map(idx => subtitlesData[idx].original);

    debugLog(`[YT Bilingual Subtitles] Translating segment ${segIdx + 1}/${segments.length} (${texts.length} lines)...`);

    try {
        chrome.runtime.sendMessage({ action: "translate_batch", texts }, (response) => {
        activeTranslationCount--;

        // background 連線失敗（service worker 被回收、擴充功能被重載等）時，
        // response 會是 undefined 且 lastError 被設定；必須讀取它，否則 Chrome 會在
        // Console 印出 "Unchecked runtime.lastError" 警告
        if (chrome.runtime.lastError) {
            seg.status = 'failed';
            seg.errorMessage = '與擴充功能背景服務的連線中斷，請重試';
            debugLog(`[YT Bilingual Subtitles] Segment ${segIdx + 1} sendMessage failed:`, chrome.runtime.lastError.message);
            if (onDone) onDone();
            processTranslationQueue();
            return;
        }

        if (response && response.success) {
            seg.lineIndices.forEach((idx, i) => {
                subtitlesData[idx].chinese = response.texts[i];
            });
            seg.status = 'done';
            debugLog(`[YT Bilingual Subtitles] Segment ${segIdx + 1} translation completed.`);
        } else {
            seg.status = 'failed';
            seg.errorMessage = friendlyErrorMessage(response && response.error);
            console.error(`[YT Bilingual Subtitles] Segment ${segIdx + 1} translation failed:`, response && response.error);
        }

        if (onDone) onDone();
        // 釋出名額後，繼續處理排隊中的段落
        processTranslationQueue();
        });
    } catch (e) {
        // chrome.runtime 在呼叫瞬間失效（例如擴充功能被重新載入）
        activeTranslationCount--;
        seg.status = 'pending';
        handleExtensionContextInvalidated();
    }
}

// 將原始錯誤訊息轉換成簡短、使用者看得懂的中文說明，方便直接顯示在字幕區
function friendlyErrorMessage(rawError) {
    if (!rawError) return '未知錯誤';
    const msg = String(rawError);
    const lower = msg.toLowerCase();

    if (lower.includes('尚未設定') || lower.includes('api key')) {
        if (lower.includes('尚未設定')) return msg; // background.js 已經給出明確訊息了，直接沿用
    }
    if (lower.includes('insufficient balance') || lower.includes('余额不足') || lower.includes('餘額不足')) {
        return 'API 帳戶餘額不足，請至該翻譯引擎官網儲值';
    }
    if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('429') || lower.includes('exceeded')) {
        return 'API 額度已用盡或請求過於頻繁，請稍後再試或更換 API Key';
    }
    if (lower.includes('invalid') && (lower.includes('key') || lower.includes('api'))) {
        return 'API Key 不正確，請至設定確認';
    }
    if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('permission')) {
        return 'API Key 未授權或權限不足';
    }
    if (lower.includes('failed to fetch') || lower.includes('network')) {
        return '網路連線異常，無法連上翻譯伺服器';
    }

    // 沒有對應到已知類型時，截斷顯示原始錯誤內容作為備援
    return msg.length > 60 ? msg.slice(0, 60) + '...' : msg;
}

// 將某段加入待翻譯佇列（避免重複加入）
function queueSegmentTranslation(segIdx) {
    const seg = segments[segIdx];
    if (!seg || seg.status !== 'pending') return;
    if (translationQueue.includes(segIdx)) return;
    translationQueue.push(segIdx);
    processTranslationQueue();
}

// 依照同時翻譯上限，從佇列中取出段落開始翻譯
function processTranslationQueue() {
    while (translationQueue.length > 0 && activeTranslationCount < MAX_CONCURRENT_TRANSLATIONS) {
        const segIdx = translationQueue.shift();
        if (segments[segIdx] && segments[segIdx].status === 'pending') {
            requestSegmentTranslation(segIdx);
        }
    }
}

// 確保目前段落之後的 PREFETCH_AHEAD 段都已經在翻譯佇列中
function ensurePrefetch(currentSegIdx) {
    for (let i = currentSegIdx; i <= currentSegIdx + PREFETCH_AHEAD && i < segments.length; i++) {
        queueSegmentTranslation(i);
    }
}

// 使用者跳轉(seek)到尚未翻譯的段落時，插隊優先翻譯該段
function prioritizeSegment(segIdx) {
    const seg = segments[segIdx];
    if (!seg || seg.status === 'done' || seg.status === 'failed') return;
    translationQueue = translationQueue.filter(i => i !== segIdx);
    translationQueue.unshift(segIdx);
    if (seg.status !== 'loading') {
        seg.status = 'pending'; // 確保 queueSegmentTranslation 的判斷成立
    }
    processTranslationQueue();
}

// 時間軸監控引擎：精確對位影片時間，並驅動分段翻譯排程
function startTimeTracker(video) {
    clearInterval(timeUpdateTimer);

    timeUpdateTimer = setInterval(() => {
        if (!isExtensionContextValid()) {
            handleExtensionContextInvalidated();
            return;
        }
        if (!video || !isEnabled || subtitlesData.length === 0 || segments.length === 0) return;

        const currentTimeMs = video.currentTime * 1000;
        const segIdx = getSegmentIndexForTime(currentTimeMs);

        // 偵測使用者是否切換到新的段落（包含 seek 前進或倒退）
        if (segIdx !== lastKnownSegmentForUser) {
            lastKnownSegmentForUser = segIdx;
            if (segments[segIdx].status === 'pending' || segments[segIdx].status === 'loading') {
                prioritizeSegment(segIdx);
            }
            ensurePrefetch(segIdx);
        }

        const seg = segments[segIdx];

        if (seg.status === 'pending' || seg.status === 'loading') {
            // 該段落還沒翻譯完成，顯示載入提示
            currentActiveSubtitle = null;
            failedShown = false;
            if (!loadingShown) {
                showLoadingIndicator('雙語字幕翻譯中...');
                loadingShown = true;
            }
            return;
        }

        if (seg.status === 'failed') {
            // 該段落翻譯失敗，顯示具體錯誤原因與重試按鈕
            currentActiveSubtitle = null;
            loadingShown = false;
            if (!failedShown || failedSegIdxShown !== segIdx) {
                showFailedIndicator(seg.errorMessage || '未知錯誤', segIdx);
                failedShown = true;
                failedSegIdxShown = segIdx;
            }
            return;
        }

        loadingShown = false;
        failedShown = false;
        failedSegIdxShown = -1;

        // 尋找當前時間對應的字幕行（主要在目前段落，跨段保險再查前一段）
        let activeSub = null;
        for (let i = 0; i < seg.lineIndices.length; i++) {
            const sub = subtitlesData[seg.lineIndices[i]];
            if (currentTimeMs >= sub.startMs && currentTimeMs <= sub.endMs) {
                activeSub = sub;
                break;
            }
        }
        if (!activeSub && segIdx > 0) {
            const prevSeg = segments[segIdx - 1];
            for (let i = 0; i < prevSeg.lineIndices.length; i++) {
                const sub = subtitlesData[prevSeg.lineIndices[i]];
                if (currentTimeMs >= sub.startMs && currentTimeMs <= sub.endMs) {
                    activeSub = sub;
                    break;
                }
            }
        }

        // 字幕改變了（或消失了）才更新畫面
        if (activeSub !== currentActiveSubtitle) {
            currentActiveSubtitle = activeSub;
            if (activeSub) {
                updateCustomCaptions(activeSub.original, activeSub.chinese);
            } else {
                updateCustomCaptions("", ""); // 清除畫面
            }
        }

    }, 50); // 每 50 毫秒檢查一次，確保零延遲
}

// 初始化
function init() {
    debugLog("[YT Bilingual Subtitles] Init function started, awaiting video player...");

    chrome.storage.local.get(['isEnabled', 'displayMode'], (result) => {
        isEnabled = result.isEnabled !== false;
        displayMode = result.displayMode || 'bilingual';
        applyToggleState();

        const checkExist = setInterval(() => {
            if (document.querySelector('.html5-video-player')) {
                debugLog("[YT Bilingual Subtitles] Player found! Ready for subtitles.");
                clearInterval(checkExist);
                createCustomCaptionContainer();
                // 我們不再使用 MutationObserver 了！改由 message 事件被動接收攔截到的字幕，
                // 並交由分段排程器（handleNewSubtitleTrack）處理翻譯與播放同步。
            }
        }, 1000);
    });
}

init();
