// 公開版預設關閉詳細 log，避免洗版使用者的 Console。除錯時可手動改成 true。
const DEBUG_MODE = false;
function debugLog(...args) {
    if (DEBUG_MODE) console.log(...args);
}

// ===== 翻譯引擎設定 =====
// OpenAI 與 DeepSeek 都使用相容的 Chat Completions API 格式，可以共用同一支呼叫函式。
const PROVIDER_LABELS = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    deepseek: 'DeepSeek'
};

const OPENAI_COMPATIBLE_CONFIG = {
    openai: {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini'
    },
    deepseek: {
        endpoint: 'https://api.deepseek.com/chat/completions',
        // 官方於 2026/7/24 停用舊別名 deepseek-chat，改用正式模型名（非思考模式，等同原 deepseek-chat）
        model: 'deepseek-v4-flash'
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translate_batch") {
        const texts = request.texts;

        chrome.storage.local.get(['translationProvider', 'apiKeys', 'geminiApiKey'], async (result) => {
            const provider = result.translationProvider || 'gemini';
            const apiKeys = result.apiKeys || {};

            // 相容舊版資料：舊版只有單一 geminiApiKey 欄位，沒有 apiKeys 物件時自動沿用
            let apiKey = apiKeys[provider];
            if (!apiKey && provider === 'gemini' && result.geminiApiKey) {
                apiKey = result.geminiApiKey;
            }

            if (!apiKey) {
                sendResponse({ success: false, error: `尚未設定 ${PROVIDER_LABELS[provider] || provider} 的 API Key` });
                return;
            }

            try {
                // 將幾百行的字幕切成小區塊 (每 100 行一批)，避免一次塞太多導致伺服器拒絕
                const chunkSize = 100;
                let allTranslated = [];

                for (let i = 0; i < texts.length; i += chunkSize) {
                    const chunk = texts.slice(i, i + chunkSize);
                    debugLog(`[YT Bilingual Subtitles] (${provider}) Translating chunk ${i / chunkSize + 1}...`);
                    const translatedChunk = await translateChunkWithRetry(chunk, provider, apiKey);
                    allTranslated = allTranslated.concat(translatedChunk);
                }

                sendResponse({ success: true, texts: allTranslated });

            } catch (error) {
                console.error(`[YT Bilingual Subtitles] (${provider}) Translation error:`, error);
                sendResponse({ success: false, error: error.toString() });
            }
        });

        return true;
    }
});

// 建立翻譯用的提示詞（所有引擎共用同一套 prompt）
function buildTranslationPrompt(chunk) {
    const chunkObj = {};
    chunk.forEach((text, idx) => {
        chunkObj[idx] = text;
    });

    return `You are a professional translator for Taiwan, specializing in Korean-to-Chinese and Japanese-to-Chinese translation.
The values of the following JSON object are subtitle lines from a YouTube video. Each line will be in either Korean or Japanese (you do not need to know which in advance — detect it per line).
Translate the values of the following JSON object into Traditional Chinese (zh-TW).
RULES:
1. Return ONLY a valid JSON object.
2. The returned JSON MUST have the EXACT SAME KEYS (0, 1, 2...) as the input JSON. Do not omit or add any keys.
3. Automatically detect whether each line is Korean or Japanese, and translate it naturally according to context.

Input JSON:
${JSON.stringify(chunkObj, null, 2)}`;
}

// 依照指定引擎、帶自動重試地翻譯一個區塊，回傳翻譯後的字串陣列
async function translateChunkWithRetry(chunk, provider, apiKey, retries = 3) {
    const prompt = buildTranslationPrompt(chunk);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            let responseText;

            if (provider === 'gemini') {
                responseText = await callGemini(apiKey, prompt);
            } else if (OPENAI_COMPATIBLE_CONFIG[provider]) {
                responseText = await callOpenAICompatible(provider, apiKey, prompt);
            } else {
                throw new Error(`未知的翻譯引擎: ${provider}`);
            }

            let parsedObj;
            try {
                parsedObj = JSON.parse(responseText);
            } catch (e) {
                const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
                parsedObj = JSON.parse(cleanText);
            }

            // 重新組裝回陣列
            const resultArray = [];
            for (let j = 0; j < chunk.length; j++) {
                // 如果 LLM 真的漏掉了某一行，我們就保留原本的韓文當作備胎
                resultArray.push(parsedObj[String(j)] || chunk[j]);
            }
            return resultArray;

        } catch (err) {
            if (attempt === retries) throw err;
            debugLog(`[YT Bilingual Subtitles] (${provider}) Error, retrying in 2 seconds... (Attempt ${attempt}):`, err.message || err);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ===== Gemini =====
// Gemini 的模型名稱會自動偵測並快取，其餘引擎使用固定模型名稱即可。
async function callGemini(apiKey, prompt) {
    // 快取鍵帶版本號 (V2)：挑選邏輯改變時換新鍵名，舊版快取的模型自動失效重選
    const stored = await chrome.storage.local.get(['cachedModelNameV2']);
    let modelName = stored.cachedModelNameV2;

    if (!modelName) {
        debugLog("[YT Bilingual Subtitles] Fetching available Gemini models...");
        const modelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const modelsData = await modelsRes.json();

        if (modelsData.models) {
            const validModels = modelsData.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
            // 依「翻譯字幕夠用就好、成本優先」的順序挑選：
            // flash-lite（最便宜）> flash（避開 8b 精簡版）> 任一 flash > 任一 gemini
            const pickFrom = (list) =>
                list.find(m => m.name.includes('flash-lite')) ||
                list.find(m => m.name.includes('flash') && !m.name.includes('8b')) ||
                list.find(m => m.name.includes('flash')) ||
                list.find(m => m.name.includes('gemini'));

            // 先在穩定版中挑（排除 preview/exp 實驗版，避免額度與存續期的不確定性），挑不到再放寬
            const stableModels = validModels.filter(m => !m.name.includes('preview') && !m.name.includes('exp'));
            const best = pickFrom(stableModels) || pickFrom(validModels);

            if (best) modelName = best.name;
        }
        if (!modelName) modelName = 'models/gemini-flash-lite-latest'; // 最後的保底：官方提供的最新 flash-lite 別名

        // 記住模型名稱，下次就不用再問了（同時清掉舊版快取鍵）
        chrome.storage.local.set({ cachedModelNameV2: modelName });
        chrome.storage.local.remove('cachedModelName');
        debugLog("[YT Bilingual Subtitles] Selected Gemini model:", modelName);
    }

    // modelName 的格式已經是 'models/gemini-...' 了
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (data.error) {
        const errMsg = data.error.message || JSON.stringify(data.error);
        // 快取的模型日後被 Google 退役時會回 404 / NOT_FOUND：
        // 清掉快取，讓 translateChunkWithRetry 的自動重試立刻重新偵測可用模型
        if (data.error.code === 404 || /not[\s_]?found/i.test(errMsg)) {
            chrome.storage.local.remove('cachedModelNameV2');
            debugLog("[YT Bilingual Subtitles] Cached Gemini model unavailable, cache cleared for re-detection.");
        }
        throw new Error(errMsg);
    }
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Gemini 回應格式異常: ' + JSON.stringify(data));
    }

    return data.candidates[0].content.parts[0].text;
}

// ===== OpenAI / DeepSeek（共用 OpenAI 相容的 Chat Completions 格式） =====
async function callOpenAICompatible(provider, apiKey, prompt) {
    const config = OPENAI_COMPATIBLE_CONFIG[provider];

    const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.3
        })
    });

    const data = await response.json();

    if (data.error) {
        const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        throw new Error(msg);
    }
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`${PROVIDER_LABELS[provider]} 回應格式異常: ` + JSON.stringify(data));
    }

    return data.choices[0].message.content;
}
