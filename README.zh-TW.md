[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **[繁體中文](README.zh-TW.md)**

# 日文名 → 輸入法短語（japanese-ime-tool）

一個 Windows 平台的 Electron 懸浮窗小工具：擷取日文名（漢字 / 羅馬音 / 平假名），並將其一鍵匯入 **微軟拼音輸入法**的「使用者自訂短語」，讓你在中文輸入法下也能快速打出日文名。

> 適用系統：Windows（依賴微軟拼音的使用者自訂短語檔 `ChsPinyinEUDPv1.lex`）。

## ✨ 功能特性

- **擷取日文名**：從 namechef 擷取一批日文名，支援依性別（女名 / 男名 / 中性）與風格（熱門 / 獨特 / 流行）篩選，依批次儲存到本機；點擊頂部儀表卡可快速切換欄位。
- **三種短語欄位**：漢字（kanji）、羅馬音（romaji）、平假名（hiragana），可隨時切換。
- **四種綁定方式**：
  - **手動**：逐行填寫輸入法編碼（拼音串），可鎖定防止誤改。
  - **手動（全域）**：編碼寫入全域預設綁定，跨批次複用，同樣可編輯與鎖定。
  - **英文鍵位順序（qwerty）**：自動依 `q w e r t y u i o p a s d f g h j k l z x c v b` 分配，最多 24 條。
  - **英文鍵位流轉順序（qwerFlow）**：依 `q w e r a s d f z x c v` 流轉分配，最多 12 條。
- **一鍵匯入**：把目前批次前 N 條名字寫入微軟拼音使用者自訂短語，匯入前彈出預覽（每屏約 10 條，可捲動），支援「此後不再提醒」。
- **資料批次管理**：下拉切換批次；每個批次右側有**綠紅雙色進度條**（綠 = 未使用 / 紅 = 已使用）即時顯示使用情況。
- **手動綁定不足提示**：手動模式下若匯入數量大於已填寫編碼行數，彈窗讓你選擇自動補全 / 強制繼續 / 取消。
- **設定面板**：切換介面語言（簡 / 繁 / 英 / 日 / 韓）與主題（亮 / 暗 / 跟隨系統）；固定視窗到最前（置頂）。
- **設定持久化**：語言、主題、短語欄位、綁定方式、匯入數量、置頂狀態、上次開啟的批次等均記入 `config.yaml`，下次啟動自動復原。

## 📋 環境要求

- Windows 10 / 11
- Node.js ≥ 18（開發執行用）
- Electron 31（作為依賴安裝）
- 已安裝並啟用**微軟拼音輸入法**

## 🚀 安裝與執行

```bash
npm install
npm start
# 或
npm run dev
```

> 說明：本工具透過寫入微軟拼音的自訂短語檔（`ChsPinyinEUDPv1.lex`）運作，匯入後需在輸入法設定中「重新載入使用者自訂短語」或重新啟動輸入法使變更生效。

## 🛠 使用說明

1. **擷取資料**：選擇性別與風格，點擊「⚡擷取」，生成並儲存一個資料批次。
2. **選擇短語欄位**：點擊頂部儀表卡（漢字 / 羅馬音 / 平假名）或下拉框切換；儀表卡會高亮目前欄位。
3. **選擇綁定方式**：手動模式逐行填編碼並鎖定；qwerty / qwerFlow 自動分配鍵位。
4. **選擇資料批次**：透過「資料批次」下拉框切換；進度條顯示各批次使用情況。
5. **一鍵匯入**：設定匯入數量，點擊「一鍵匯入」，預覽確認後寫入輸入法。
6. **撤回 / 清除**：「撤回」可撤銷上一次匯入；「一鍵清除」清空全部自訂短語（可撤回復原）。

## ⚙️ 設定（config.yaml）

設定檔位於 `data/config.yaml`，支援的欄位：

| 欄位 | 說明 | 預設值 |
| --- | --- | --- |
| `gender` | 擷取性別 G/B/U | `G` |
| `popularity` | 擷取風格 popular/unique/trending | `popular` |
| `phraseField` | 短語欄位 kanji/romaji/hiragana | `kanji` |
| `binding` | 綁定方式 manual/manualGlobal/qwerty/qwerFlow | `manual` |
| `count` | 匯入數量 | `10` |
| `lang` | 介面語言 zh-CN/zh-TW/en/ja/ko | `zh-CN` |
| `theme` | 主題 light/dark/system | `system` |
| `pinned` | 是否置頂 | `false` |
| `lastBatch` | 上次開啟的資料批次名（啟動自動復原） | `''` |
| `skipImportPreview` | 是否跳過匯入預覽 | `false` |
| `orderMode` | 候選位置模式 fixed/auto | `fixed` |
| `orderValue` | 固定模式候選位置 | `1` |

## 🧪 測試

```bash
npm test
```

執行 Dat 往返、綁定策略與解析器的單元測試。

## 📁 專案結構（簡要）

```
japanese-ime-tool/
├── main.js                      # Electron 主程序
├── preload.cjs                  # 渲染程序橋接
├── renderer/                    # 介面（HTML/CSS/JS）
├── src/
│   ├── implementations/binding/ # 綁定策略（manual/qwerty/qwerFlow…）
│   ├── implementations/exporter/ # 匯出器（mschxudp / UDL / dat）
│   ├── services/                # 匯入服務
│   └── store/                   # 設定儲存（config.yaml）
└── data/lang/                   # 多語言包（zh-CN/zh-TW/en/ja/ko）
```

## ⚠️ 注意事項

- 僅支援 Windows + 微軟拼音輸入法，依賴使用者自訂短語檔格式。
- 匯入的短語需帶有效編碼（觸發碼）；空編碼的條目無法在輸入法設定中編輯。
- 擷取功能依賴第三方網站結構，可能隨對方改版失效，請留意更新。

## 📄 授權

未指定授權條款。使用前請自行確認合規。
