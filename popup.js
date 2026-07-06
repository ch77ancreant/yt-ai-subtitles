document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.getElementById('toggleSwitch');
    const providerSelect = document.getElementById('providerSelect');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const keyHint = document.getElementById('keyHint');
    const saveBtn = document.getElementById('saveBtn');
    const saveMsg = document.getElementById('saveMsg');
    const displayModeRadios = document.querySelectorAll('input[name="displayMode"]');

    const KEY_HINTS = {
        gemini: '可至 aistudio.google.com 取得 Gemini API Key。',
        openai: '可至 platform.openai.com 取得 OpenAI API Key。',
        deepseek: '可至 platform.deepseek.com 取得 DeepSeek API Key。'
    };

    let apiKeys = {};
    let currentProvider = 'gemini';

    function loadKeyForProvider(provider) {
        apiKeyInput.value = apiKeys[provider] || '';
        keyHint.textContent = KEY_HINTS[provider] || '';
    }

    // 載入目前設定
    chrome.storage.local.get(['isEnabled', 'translationProvider', 'apiKeys', 'geminiApiKey', 'displayMode'], (result) => {
        // 預設為開啟
        toggleSwitch.checked = result.isEnabled !== false;

        // 顯示內容：套用已儲存的值，沒有的話用預設值（雙語）
        const savedDisplayMode = result.displayMode || 'bilingual';
        displayModeRadios.forEach(radio => { radio.checked = (radio.value === savedDisplayMode); });

        apiKeys = result.apiKeys || {};

        // 相容舊版資料：舊版只存了單一 geminiApiKey，把它搬進新的 apiKeys 結構裡
        if (!apiKeys.gemini && result.geminiApiKey) {
            apiKeys.gemini = result.geminiApiKey;
            chrome.storage.local.set({ apiKeys });
        }

        currentProvider = result.translationProvider || 'gemini';
        providerSelect.value = currentProvider;
        loadKeyForProvider(currentProvider);
    });

    // 儲存開關狀態
    toggleSwitch.addEventListener('change', () => {
        chrome.storage.local.set({ isEnabled: toggleSwitch.checked });
    });

    // 顯示內容（雙語／只顯示中文）：選擇後立即儲存生效
    displayModeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                chrome.storage.local.set({ displayMode: radio.value });
            }
        });
    });

    // 切換翻譯引擎：先把目前輸入框內容暫存到記憶體（避免來回切換時遺失尚未儲存的輸入），
    // 再切換顯示對應引擎已儲存的 Key，並立即記住使用者選擇的引擎
    providerSelect.addEventListener('change', () => {
        apiKeys[currentProvider] = apiKeyInput.value.trim();
        currentProvider = providerSelect.value;
        chrome.storage.local.set({ translationProvider: currentProvider });
        loadKeyForProvider(currentProvider);
    });

    // 儲存目前選擇引擎的 API Key
    saveBtn.addEventListener('click', () => {
        apiKeys[currentProvider] = apiKeyInput.value.trim();

        chrome.storage.local.set({ apiKeys, translationProvider: currentProvider }, () => {
            saveMsg.style.display = 'block';
            setTimeout(() => {
                saveMsg.style.display = 'none';
            }, 2000);
        });
    });
});
