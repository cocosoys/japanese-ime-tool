[**简体中文**](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [繁體中文](README.zh-TW.md)

# 日文名 → 输入法短语（japanese-ime-tool）

一个 Windows 平台的 Electron 悬浮窗小工具：抓取日文名（汉字 / 罗马音 / 平假名），并将其一键导入 **微软拼音输入法**的「用户自定义短语」，让你在中文输入法下也能快速打出日文名。

> 适用系统：Windows（依赖微软拼音的用户自定义短语文件 `ChsPinyinEUDPv1.lex`）。

## ✨ 功能特性

- **抓取日文名**：从 namechef 抓取一批日文名，支持按性别（女名 / 男名 / 中性）与风格（热门 / 独特 / 流行）筛选，按批次保存到本地。
- **三种短语字段**：汉字（kanji）、罗马音（romaji）、平假名（hiragana），可随时切换；点击顶部仪表卡即可快速切换。
- **四种绑定方式**：
  - **手动**：逐行填写输入法编码（拼音串），可锁定防止误改。
  - **手动（全局）**：编码写入全局默认绑定，跨批次复用，同样可编辑与锁定。
  - **英文键位顺序（qwerty）**：自动按 `q w e r t y u i o p a s d f g h j k l z x c v b` 分配，最多 24 条。
  - **英文键位流转顺序（qwerFlow）**：按 `q w e r a s d f z x c v` 流转分配，最多 12 条。
- **一键导入**：把当前批次前 N 条名字写入微软拼音用户自定义短语，导入前弹出预览（每屏约 10 条，可滚动），支持「此后不再提醒」。
- **数据批次管理**：下拉切换批次；每个批次右侧有**绿红双色进度条**（绿 = 未使用 / 红 = 已使用）实时显示使用情况。
- **手动绑定不足提示**：手动模式下若导入数量大于已填写编码行数，弹窗让你选择自动补全 / 强制继续 / 取消。
- **设置面板**：切换界面语言（简 / 繁 / 英 / 日 / 韩）与主题（亮 / 暗 / 跟随系统）；固定窗口到最前（置顶）。
- **配置持久化**：语言、主题、短语字段、绑定方式、导入数量、置顶状态、上次打开的批次等均记入 `config.yaml`，下次启动自动恢复。

## 📋 环境要求

- Windows 10 / 11
- Node.js ≥ 18（开发运行用）
- [Electron](https://www.electronjs.org/) 31（作为依赖安装）
- 已安装并启用**微软拼音输入法**

## 🚀 安装与运行

```bash
# 安装依赖
npm install

# 开发模式启动（Electron 窗口）
npm start
# 或
npm run dev
```

> 说明：本工具通过写入微软拼音的自定义短语文件（`ChsPinyinEUDPv1.lex`）工作，导入后需在输入法设置中「重新加载用户自定义短语」或重启输入法使改动生效。

## 🛠 使用说明

1. **抓取数据**：选择性别与风格，点击「⚡抓取」，生成并保存一个数据批次。
2. **选择短语字段**：点击顶部仪表卡（汉字 / 罗马音 / 平假名）或下拉框切换；仪表卡会高亮当前字段。
3. **选择绑定方式**：手动模式逐行填编码并锁定；qwerty / qwerFlow 自动分配键位。
4. **选择数据批次**：通过「数据批次」下拉框切换；进度条显示各批次使用情况。
5. **一键导入**：设置导入数量，点击「一键导入」，预览确认后写入输入法。
6. **撤回 / 清除**：「撤回」可撤销上一次导入；「一键清除」清空全部自定义短语（可撤回恢复）。

## ⚙️ 配置（config.yaml）

配置文件位于 `data/config.yaml`，支持的字段：

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `gender` | 抓取性别 G/B/U | `G` |
| `popularity` | 抓取风格 popular/unique/trending | `popular` |
| `phraseField` | 短语字段 kanji/romaji/hiragana | `kanji` |
| `binding` | 绑定方式 manual/manualGlobal/qwerty/qwerFlow | `manual` |
| `count` | 导入数量 | `10` |
| `lang` | 界面语言 zh-CN/zh-TW/en/ja/ko | `zh-CN` |
| `theme` | 主题 light/dark/system | `system` |
| `pinned` | 是否置顶 | `false` |
| `lastBatch` | 上次打开的数据批次名（启动自动恢复） | `''` |
| `skipImportPreview` | 是否跳过导入预览 | `false` |
| `orderMode` | 候选位置模式 fixed/auto | `fixed` |
| `orderValue` | 固定模式候选位置 | `1` |

## 🧪 测试

```bash
npm test
```

运行 Dat 往返、绑定策略与解析器的单元测试。

## 📁 项目结构（简要）

```
japanese-ime-tool/
├── main.js                      # Electron 主进程
├── preload.cjs                  # 渲染进程桥接
├── renderer/                    # 界面（HTML/CSS/JS）
├── src/
│   ├── implementations/binding/ # 绑定策略（manual/qwerty/qwerFlow…）
│   ├── implementations/exporter/ # 导出器（mschxudp / UDL / dat）
│   ├── services/                # 导入服务
│   └── store/                   # 配置存储（config.yaml）
└── data/lang/                   # 多语言包（zh-CN/zh-TW/en/ja/ko）
```

## ⚠️ 注意事项

- 仅支持 Windows + 微软拼音输入法，依赖用户自定义短语文件格式。
- 导入的短语需带有效编码（触发码）；空编码的条目无法在输入法设置中编辑。
- 抓取功能依赖第三方网站结构，可能随对方改版失效，请留意更新。

## 📄 许可

未指定许可证。使用前请自行确认合规。
