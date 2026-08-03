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
  - **QWERTY key order**: auto-assigned by `q w e r t y u i o p a s d f g h j k l z x c v b n m`, up to 26 entries.
  - **QWERTY flow order (qwerFlow)**: assigned by the rotating sequence `q w e r a s d f z x c v`, up to 12 entries.
- **One-click import**: write the first N names of the current batch into Microsoft Pinyin user phrases. A preview is shown before importing (≈10 per screen, scrollable) with a "Don't remind me again" option.
- **All data batches (aggregate)**: the first dropdown item "All data batches" aggregates every batch; names are consumed **oldest batch first**, and **already-used data is never reused** — when the current data is short of the import count, a placeholder preview appears (missing entries shown in yellow as "Generated after confirm"), then after confirmation the tool **auto-fetches in multiple rounds** (with a live progress dialog that can be force-stopped), and finally shows the real preview again for a second confirmation.
- **Batch management**: switch batches via dropdown; the list is refreshed automatically every time it opens, showing 5 batches per screen — more batches scroll via the wheel or a **thin translucent vertical scrollbar**; each batch has a **green/red dual-color progress bar** (green = unused / red = used) showing usage in real time. Batch folders are named by fetch time (`YYYY-MM-DD_HHmmss_ms`, e.g. `2026-07-31_114932_1785469772230`).
- **Manual-binding shortage prompt**: in Manual mode, if the import count exceeds the number of rows with a code filled, a dialog lets you auto-complete / force-continue / cancel.
- **In-app confirmation dialogs**: destructive actions such as "Clear all" use the same in-app dialog style as the import preview (with a "Don't remind me again" checkbox, persisted once ticked).
- **Compact status bar + developer mode**: by default the status bar shows a compact result (e.g. "Imported 21 entries → IME reloaded"); enabling "Developer mode" in settings shows full diagnostics (file paths, reload method, etc.).
- **Settings panel**: switch UI language (zh/zh-TW/en/ja/ko) and theme (light/dark/system); pin the window on top; developer-mode toggle.
- **Local HTTP API**: a built-in local API service (bound to `127.0.0.1`) that can be toggled from the settings panel; when enabled, the API documentation link (`docs/api-docs.html`) is shown below it, handy for developers to integrate or automate.
- **Close behavior**: clicking the close button shows a choice (close the app / hide to tray). You can tick "Remember" to persist it and apply directly on next launch.
- **Persistent config**: language, theme, phrase field, binding mode, import count, pin state, API toggle, close behavior, and last opened batch are saved to `config.yaml` and restored on next launch.

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
4. **Choose batch**: switch via the "Data batch" dropdown (auto-refreshed every time it opens); the progress bar shows each batch's usage; choose "All data batches" to consume every batch oldest-first in aggregate.
5. **One-click import**: set the count, click "Import", confirm the preview, then it's written to the IME. If "All data batches" lacks enough data, a placeholder preview appears first (missing rows shown yellow as "Generated after confirm"); after confirmation the tool auto-fetches in multiple rounds (force-stoppable), then shows the final preview for a second confirmation.
6. **Undo / Clear**: "Undo" reverts the last import; "Clear all" empties all user phrases (in-app confirmation with "Don't remind me again"; undoable).

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
| `skipClearConfirm` | Skip the "Clear all" confirmation dialog | `false` |
| `skipUsedInSlice` | Skip the "partially used data" prompt | `false` |
| `skipOrderAdjust` / `skipOrderOverwrite` | Skip candidate-position conflict adjust / overwrite confirmation | `false` |
| `orderMode` | Candidate position mode fixed/auto | `fixed` |
| `orderValue` | Fixed-mode candidate position | `1` |
| `apiEnabled` | Whether the local HTTP API is enabled | `true` |
| `apiPort` | Local HTTP API listening port | `18765` |
| `closeBehavior` | Close-button behavior: ask=prompt / close=quit directly / minimize=hide to tray | `ask` |
| `devMode` | Developer mode (status bar shows full diagnostics) | `false` |

## 🔌 Local API (for developers)

A built-in local HTTP API bound only to `127.0.0.1`, for scripting import / export / query of phrases.

- **Enable / disable**: click the "Enabled" text on the right of "Local API" in the settings panel to toggle it; when enabled, the API documentation link is shown below.
- **Persistence**: toggle state and port are written to `config.yaml` (`apiEnabled` / `apiPort`) and survive restarts.
- **Docs**: full endpoint list, parameters, and `curl` examples are in **`docs/api-docs.html`** (open via the doc link after enabling the API in settings, or open the file directly in a browser).

> Note: the API binds only to the local loopback address and is not exposed to the network; do not keep it enabled for long on an untrusted shared machine.

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
│   ├── api/                     # Local HTTP API service
│   ├── implementations/         # Binding strategies / exporters / parsers / sources
│   ├── services/                # Import service
│   ├── store/                   # Config storage (config.yaml)
│   └── updater/                 # In-app auto-update (read version.json + asar hot-swap)
├── scripts/
│   ├── build.mjs                # Build orchestration (obfuscate + package + archive + extract asar)
│   ├── obfuscate.mjs            # Code obfuscation
│   └── gen_icon.py              # Icon generation
├── tools/                       # Dev / integration-test helper scripts
├── docs/
│   └── api-docs.html            # Local API docs (styled)
├── data/lang/                   # Language packs (zh-CN/zh-TW/en/ja/ko)
├── .github/workflows/           # CI auto build & release
├── CHANGELOG.md                 # Version changelog
└── version.json                 # Update manifest (read by auto-update)
```

## ⚠️ Notes

- Windows + Microsoft Pinyin IME only; depends on the user-defined phrase file format.
- Imported phrases need a valid code (trigger code); entries with empty codes cannot be edited in IME settings.
- The scraping feature depends on a third-party site's structure and may break if it changes.
- Batch folders are named `YYYY-MM-DD_HHmmss_ms` (e.g. `2026-07-31_114932_1785469772230`); legacy `YYYY-MM-DD_HHmm` folders are still recognized.
- The three lexicon files (UDL / EUDP / machxudp) are written together and deduplicated consistently by code+phrase, avoiding "edit failed" in the IME settings caused by mismatched entry counts.

## 📦 Build & Release

```bash
# Local build (obfuscate → NSIS installer + portable → archive to release/<version>/, extract app-<version>.asar)
npm run dist
```

- Artifacts are written to `release/<version>/`:
  - `JapaneseImeTool Setup <version>.exe` — NSIS installer
  - `JapaneseImeTool Portable <version>.exe` — portable (no install) build
  - `app-<version>.asar` — app archive (used for auto-update hot-swap)
- **Auto-release**: pushing a commit whose message is exactly `Release: x.y.z` on `main` triggers GitHub Actions to build and create a GitHub Release, uploading the three artifacts above. The **in-app auto-update** reads `version.json` at the repo root to detect new versions and downloads `app-<version>.asar` for a hot-swap.
- Downloads: the repo's **Releases** page provides the Setup (installer) and Portable builds.

## 📄 License

No license specified. Confirm compliance before use.
