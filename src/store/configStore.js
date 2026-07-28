import { promises as fs } from 'fs';
import path from 'path';

/**
 * 用户配置存储 → ./data/config.yaml
 * 记录：获取名称(gender)、热门类型(popularity)、短语字段(phraseField)、
 *      绑定方式(binding)、导入数量(count)
 * 采用扁平 key: value 格式的极简 YAML（无第三方依赖）。
 */
const DEFAULTS = {
  gender: 'G',            // 获取名称：G=女名 B=男名 U=中性
  popularity: 'popular',  // 热门类型：popular/unique/trending
  phraseField: 'kanji',   // 短语字段：kanji/romaji/hiragana/cnSimplified
  binding: 'romaji',      // 绑定方式：romaji/sequential/chineseApprox/manual
  count: 10,              // 导入数量
};

function toYaml(obj) {
  const lines = ['# japanese-ime-tool 用户配置（自动保存，勿手动破坏格式）'];
  for (const [k, v] of Object.entries(obj)) lines.push(`${k}: ${v}`);
  return lines.join('\n') + '\n';
}

function parseYaml(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf(':');
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    out[key] = val;
  }
  return out;
}

export class ConfigStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.join(process.cwd(), 'data', 'config.yaml');
  }

  /** 读取配置（缺失/损坏时返回默认值，多余字段保留） */
  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return { ...DEFAULTS, ...parseYaml(text) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** 保存配置（与现有配置合并，避免丢字段） */
  async save(partial) {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, toYaml(merged), 'utf8');
    return merged;
  }
}

export { DEFAULTS as CONFIG_DEFAULTS };
