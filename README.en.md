[简体中文](README.md) · **[English](README.en.md)** · [日本語](README.ja.md) · [한국어](README.ko.md) · [繁體中文](README.zh-TW.md)

# Japanese Names → IME Phrases (japanese-ime-tool)

A small Electron floating-window tool for Windows that scrapes Japanese names (kanji / romaji / hiragana) and imports them as **Microsoft Pinyin IME user-defined phrases** in one click, so you can type Japanese names quickly even while using a Chinese IME.

> Platform: Windows (depends on the Microsoft Pinyin user-defined phrase file `ChsPinyinEUDPv1.lex`).

## ✨ Features

- **Scrape Japanese names**: fetch a batch from namechef, filter by gender (female / male / neutral) and style (popular / unique / trending), saved locally per batch.
- **Three phrase fields**: kanji, romaji, hiragana — switch anytime (click a top stat card to switch quickly).
- **Four binding modes**:
  - **Manual**: fill the IME code (pinyin string) row by row; lockable to prevent accidental changes.
  - **Manual (global)**: codes are written to a global default binding, reused across batches, also editable and lockable.
  - **QWERTY key order**: auto-assigned by `q w e r t y u i o p a s d f g h j k l z x c v b`, up to 24 entries.
  - **QWERTY flow order (qwerFlow)**: assigned by the rotating sequence `q w e r a s d f z x c v`, up to 12 entries.
- **One-click import**: write the first N names of the current batch into Microsoft Pinyin user phrases. A preview is shown before importing (≈10 per screen, scrollable) with a "Don't remind me again" option.
- **Batch management**: switch batches via dropdown; each batch has a **green/red dual-color progress bar** (green = unused / red = used) showing usage in real time.
- **Manual-binding shortage prompt**: in Manual mode, if the import count exceeds the number of rows with a code filled, a dialog lets you auto-complete / force-continue / cancel.
- **Settings panel**: switch UI language (zh/zh-TW/en/ja/ko) and theme (light/dark/system); pin the window on top.
- **Persistent config**: language, theme, phrase field, binding mode, import count, pin state, and last opened batch are saved to `config.yaml` and restored on next launch.

## 📋 Requirements

- Windows 10 / 11
- Node.js ≥ 18 (for development)
- Electron 31 (installed as a dependency)
- Microsoft Pinyin IME installed and enabled

## 🚀 Install & Run

```bash
npm install
npm start
# or
npm run dev
```

> Note: the tool writes to the Microsoft Pinyin user-defined phrase file (`ChsPinyinEUDPv1.lex`). After importing, "reload user-defined phrases" in the IME settings or restart the IME to apply changes.

## 🛠 Usage

1. **Fetch data**: choose gender and style, click "⚡Fetch" to generate and save a batch.
2. **Choose phrase field**: click a top stat card (kanji / romaji / hiragana) or use the dropdown; the active card is highlighted.
3. **Choose binding mode**: Manual fills codes row by row and locks; qwerty / qwerFlow auto-assign keys.
4. **Choose batch**: switch via the "Data batch" dropdown; the progress bar shows each batch's usage.
5. **One-click import**: set the count, click "Import", confirm the preview, then it's written to the IME.
6. **Undo / Clear**: "Undo" reverts the last import; "Clear all" empties all user phrases (undoable).

## ⚙️ Configuration (config.yaml)

Located at `data/config.yaml`:

| Field | Description | Default |
| --- | --- | --- |
| `gender` | Scrape gender G/B/U | `G` |
| `popularity` | Scrape style popular/unique/trending | `popular` |
| `phraseField` | Phrase field kanji/romaji/hiragana | `kanji` |
| `binding` | Binding mode manual/manualGlobal/qwerty/qwerFlow | `manual` |
| `count` | Import count | `10` |
| `lang` | UI language zh-CN/zh-TW/en/ja/ko | `zh-CN` |
| `theme` | Theme light/dark/system | `system` |
| `pinned` | Pin on top | `false` |
| `lastBatch` | Last opened batch name (restored on launch) | `''` |
| `skipImportPreview` | Skip import preview | `false` |
| `orderMode` | Candidate position mode fixed/auto | `fixed` |
| `orderValue` | Fixed-mode candidate position | `1` |

## 🧪 Tests

```bash
npm test
```

Runs Dat roundtrip, binding strategy, and parser unit tests.

## 📁 Project Structure (brief)

```
japanese-ime-tool/
├── main.js                      # Electron main process
├── preload.cjs                  # Renderer bridge
├── renderer/                    # UI (HTML/CSS/JS)
├── src/
│   ├── implementations/binding/ # Binding strategies (manual/qwerty/qwerFlow…)
│   ├── implementations/exporter/ # Exporters (mschxudp / UDL / dat)
│   ├── services/                # Import service
│   └── store/                   # Config storage (config.yaml)
└── data/lang/                   # Language packs (zh-CN/zh-TW/en/ja/ko)
```

## ⚠️ Notes

- Windows + Microsoft Pinyin IME only; depends on the user-defined phrase file format.
- Imported phrases need a valid code (trigger code); entries with empty codes cannot be edited in IME settings.
- The scraping feature depends on a third-party site's structure and may break if it changes.

## 📄 License

No license specified. Confirm compliance before use.
