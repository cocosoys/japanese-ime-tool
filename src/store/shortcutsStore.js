import { promises as fs } from 'fs';
import path from 'path';

/**
 * 快捷键配置存储 → ./data/shortcuts.json
 *
 * 结构：
 * {
 *   "capture":           { "combo": "Alt+X", "enabled": true },
 *   "doImport":          { "combo": "Alt+V", "enabled": true },
 *   "doClear":           { "combo": "Alt+C", "enabled": true },
 *   "doUndo":            { "combo": "Alt+Z", "enabled": true },
 *   "togglePhraseField": { "combo": "Alt+B", "enabled": true }
 * }
 *
 * - combo：规范化的组合键字符串，如 "Alt+X" / "Ctrl+Alt+K" / "F5" / "A"（修饰键在前、主键在后，最多 3 个按键）
 * - enabled：是否启用；禁用后对应的全局快捷键不再触发（持久化保存）
 *
 * 与 bindings.json 同样采用独立 JSON 文件，避免写入扁平 YAML（config.yaml 仅支持标量）。
 */
const DEFAULT_PATH = path.join(process.cwd(), 'data', 'shortcuts.json');

// 5 个可触发动作及其出厂默认组合键（Alt+X/V/C/Z/B）
export const SHORTCUT_ACTIONS = ['capture', 'doImport', 'doClear', 'doUndo', 'togglePhraseField'];

export const DEFAULT_SHORTCUTS = {
  capture: { combo: 'Alt+X', enabled: true },
  doImport: { combo: 'Alt+V', enabled: true },
  doClear: { combo: 'Alt+C', enabled: true },
  doUndo: { combo: 'Alt+Z', enabled: true },
  togglePhraseField: { combo: 'Alt+B', enabled: true },
};

export function defaultShortcuts() {
  const out = {};
  for (const k of SHORTCUT_ACTIONS) out[k] = { ...DEFAULT_SHORTCUTS[k] };
  return out;
}

export class ShortcutsStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || DEFAULT_PATH;
  }

  /** 读取全部快捷键配置（缺失/损坏时回退默认值；保证 5 个动作齐全） */
  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object') return defaultShortcuts();
      const out = defaultShortcuts();
      for (const k of SHORTCUT_ACTIONS) {
        if (obj[k] && typeof obj[k] === 'object') {
          out[k] = {
            combo: typeof obj[k].combo === 'string' ? obj[k].combo : DEFAULT_SHORTCUTS[k].combo,
            enabled: obj[k].enabled !== false,
          };
        }
      }
      return out;
    } catch {
      return defaultShortcuts();
    }
  }

  /**
   * 保存快捷键配置（与现有配置合并，避免丢字段）。
   * @param {Object} partial - { [action]: { combo, enabled } }
   */
  async save(partial) {
    const current = await this.load();
    const merged = { ...current, ...(partial || {}) };
    // 规整每个动作的形状，确保 combo 为字符串、enabled 为布尔
    for (const k of SHORTCUT_ACTIONS) {
      const v = merged[k];
      merged[k] = {
        combo: v && typeof v.combo === 'string' ? v.combo : '',
        enabled: !(v && v.enabled === false),
      };
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }
}

export { DEFAULT_PATH as SHORTCUTS_DEFAULT_PATH };
