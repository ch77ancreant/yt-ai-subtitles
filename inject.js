// 公開版預設關閉詳細 log，避免洗版使用者的 Console。除錯時可手動改成 true。
const DEBUG_MODE = false;
function debugLog(...args) {
    if (DEBUG_MODE) console.log(...args);
}

// 目前支援攔截並翻譯的原始字幕語言：韓文、日文。
// 之後要加入新語言，只需要在這個陣列加上對應的語言代碼即可。
const SUPPORTED_SOURCE_LANGS = ['ko', 'ja'];

// 判斷這個請求是不是我們要攔截的 YouTube timedtext 字幕請求
// （路徑包含 /api/timedtext，且 lang 參數是我們支援的語言之一）
function isSupportedSubtitleUrl(url) {
    if (!url || !url.includes('/api/timedtext')) return false;
    try {
        const parsed = new URL(url, location.href);
        const lang = parsed.searchParams.get('lang') || '';
        // lang 參數有時會帶地區後綴（例如 ja-JP），所以用「開頭比對」而不是完全相等
        return SUPPORTED_SOURCE_LANGS.some(code => lang === code || lang.startsWith(code + '-'));
    } catch (e) {
        // URL 解析失敗時，退回用字串比對，避免漏掉攔截
        return SUPPORTED_SOURCE_LANGS.some(code => url.includes(`lang=${code}`));
    }
}

debugLog("[YT Bilingual Subtitles] Inject script loaded. Hooking fetch and XHR...");

// Hook Fetch
const originalFetch = window.fetch;
window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

    // 檢查是否為 YouTube 下載字幕的請求，且語言是我們支援的來源語言（韓文/日文）
    if (isSupportedSubtitleUrl(url)) {
        debugLog("[YT Bilingual Subtitles] Intercepted timedtext fetch:", url);
        try {
            const response = await originalFetch.apply(this, args);
            // 複製一份回應，以免破壞原本網頁的讀取
            const clone = response.clone();
            clone.json().then(data => {
                // 將拿到的字幕整包丟給 content.js
                window.postMessage({
                    type: 'YT_SUBTITLE_INTERCEPT',
                    data: data,
                    url: url
                }, '*');
            }).catch(err => console.error("Error parsing intercepted JSON:", err));
            return response;
        } catch (e) {
            return originalFetch.apply(this, args);
        }
    }
    return originalFetch.apply(this, args);
};

// Hook XHR (以防 YouTube 退回使用 XMLHttpRequest)
const originalXhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return originalXhrOpen.call(this, method, url, ...rest);
};

const originalXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
        if (isSupportedSubtitleUrl(this._url)) {
            debugLog("[YT Bilingual Subtitles] Intercepted timedtext XHR:", this._url);
            try {
                const data = JSON.parse(this.responseText);
                window.postMessage({
                    type: 'YT_SUBTITLE_INTERCEPT',
                    data: data,
                    url: this._url
                }, '*');
            } catch(e) {}
        }
    });
    return originalXhrSend.apply(this, args);
};
