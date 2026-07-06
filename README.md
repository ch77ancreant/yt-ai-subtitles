<p align="center">
  <img src="icons/icon128.png" alt="日/韓語AI翻譯字幕" width="96">
</p>

<h1 align="center">日/韓語AI翻譯字幕</h1>

<p align="center">
  看日韓 YouTube 影片，即時翻譯成繁體中文雙語字幕。<br>
  免費・開源・無廣告・無追蹤・你的 API Key 只留在你的瀏覽器。
</p>

---

## 這是什麼？

一個 Chrome 擴充功能：當你觀看有日文或韓文字幕（CC）的 YouTube 影片時，它會即時將字幕翻譯成繁體中文，以「原文＋中文」雙語形式優雅地疊加在畫面上。

- **雙語顯示**：金色原文＋白色中文，可切換成只顯示中文
- **邊看邊譯**：影片依段落在背景預先翻譯，跳轉進度會優先翻譯該段
- **三種 AI 引擎**：Google Gemini／OpenAI／DeepSeek 自由選擇，API Key 各自分開保存
- **翻譯失敗可一鍵重試**，錯誤原因以中文清楚顯示
- **低干擾**：淡化背板不擋畫面，點擊可穿透到影片

## 安裝

- **Chrome 線上應用程式商店**：（上架審核中，連結即將補上）
- **手動安裝（開發者模式）**：
  1. 下載或 clone 本專案
  2. 打開 `chrome://extensions`，開啟右上角「開發人員模式」
  3. 點「載入未封裝項目」，選擇專案資料夾

## 使用方式

1. 取得任一家的 API Key：
   - [Google AI Studio](https://aistudio.google.com)（Gemini，有免費額度）
   - [OpenAI Platform](https://platform.openai.com)
   - [DeepSeek Platform](https://platform.deepseek.com)
2. 點擊工具列圖示，選擇翻譯引擎、貼上 API Key，儲存
3. 打開有日/韓文字幕的 YouTube 影片並開啟 CC
4. 雙語字幕自動出現

## 看一部影片要花多少錢？

擴充功能本身免費，翻譯費用由你自己的 API Key 支付。以「對話密集的 1 小時影片」（約 800 句字幕）估算：

| 引擎 | 每小時影片 | 每天 1 小時×一個月 |
|---|---|---|
| DeepSeek | ≈ US$0.01（台幣約 0.3 元） | 台幣 10 元上下 |
| OpenAI（gpt-4o-mini） | ≈ US$0.02（台幣約 0.6 元） | 台幣 20 元上下 |
| Gemini（Flash-Lite） | ≈ US$0.04（台幣約 1.3 元） | 台幣 40 元上下 |

Gemini 提供免費額度，可以零成本試用。（估算基於 2026 年 7 月官方牌價，實際依影片字幕多寡而異。）

## 隱私

- API Key 與所有設定只儲存在瀏覽器本機的 `chrome.storage.local`
- 字幕文字直接從你的瀏覽器送往你選擇的 AI 服務商，**沒有任何中間伺服器**
- 不蒐集瀏覽紀錄、無廣告、無追蹤程式碼

完整內容見 [隱私權政策](PRIVACY_POLICY.md)。

## 技術架構

```
inject.js (MAIN world)          content.js (ISOLATED world)      background.js (Service Worker)
攔截 YouTube timedtext 請求  →  分段翻譯排程＋字幕渲染        →  呼叫 Gemini / OpenAI / DeepSeek
      postMessage                    chrome.runtime 訊息               批次翻譯（JSON 模式）
```

- 字幕依「行數」切段（首段特別小），第一段翻完即恢復播放，其餘段落背景預翻
- Gemini 模型自動偵測（優先挑選 Flash-Lite），模型被退役時自動重選
- YouTube SPA 換頁偵測，避免字幕殘留

## 支持開發

如果這個擴充功能讓你看影片體驗變好了，歡迎請開發者喝杯咖啡 ☕

**[→ 贊助連結（Portaly）](https://portaly.cc/chunghan)**

也歡迎開 Issue 回報問題或提功能建議！

## 授權

[GPL-3.0](LICENSE) — 歡迎學習與改作，但衍生作品必須以相同授權開源。
