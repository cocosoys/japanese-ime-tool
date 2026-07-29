import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLangDir, isValidLangFile } from './langPaths.js';

// ESM 下 __dirname 并非全局，用 import.meta.url 推导，使其在 Node 测试与
// Electron 打包（含 asar，__dirname 指向 app.asar/src/store）两种环境均可解析。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 配置文件完整性检测与隔离。
 *
 * 启动时扫描所有需加载的配置/数据文件，发现损坏、结构非法、为空等异常时
 * 不崩溃（跳过该文件、用默认值继续），并缓存异常清单；全部检测完成后由
 * 渲染层弹框列出异常范围，用户可一键「隔离」——将异常文件重命名为
 * `原名_error_<毫秒时间戳>`，使其脱离加载路径，再用默认配置重新加载。
 */

// 文件「不存在」时的处置：null=可跳过（程序回退默认/生成）；字符串=视为异常
const MISSING_RULE = {
  yaml: null,                // config.yaml 缺失 → 程序生成默认
  'json-object': null,       // bindings.json 缺失 → 返回 {}
  lang: '语言包文件缺失',      // lang 包随包分发，缺失即异常
  name: '批次数据 name.json 缺失',
  used: null,                // used.json 为导入后生成，缺失属正常
};

// 语言包目标由运行时语言目录动态扫描得出（不再写死语言码列表）：
// 任何按 i18n 命名（isValidLangFile）放入 lang 目录的 .json 都会被纳入检测，
// 例如用户新增的 hi_IN.json 也能被识别；非 i18n 命名的 .json 被忽略。
async function buildTargets(root, langDir = getLangDir()) {
  const dataDir = path.join(root, 'data');
  const targets = [
    { file: path.join(dataDir, 'config.yaml'), kind: 'yaml' },
    { file: path.join(dataDir, 'bindings.json'), kind: 'json-object' },
  ];
  // 语言包：运行时实际加载/回退的可写目录（开发 cwd/data/lang；生产 userData/lang）。
  // 注意：语言包异常由加载器从内置表恢复，不在此处重命名隔离。
  try {
    const files = await fs.readdir(langDir);
    for (const f of files) {
      if (isValidLangFile(f)) targets.push({ file: path.join(langDir, f), kind: 'lang' });
    }
  } catch { /* 语言目录不存在则跳过 */ }
  return targets;
}

// 与 configStore.parseYaml 保持一致的极简 YAML 解析（仅用于检测能否解析）
function tryParseYaml(text) {
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

/**
 * 检测单个文件完整性，返回异常原因字符串或 null（正常/可跳过）。
 */
async function checkOne(t) {
  let stat;
  try {
    stat = await fs.stat(t.file);
  } catch {
    return MISSING_RULE[t.kind] ?? null; // 不存在：按规则判定是否异常
  }
  if (stat.size === 0) return '文件为空';

  let text;
  try {
    text = await fs.readFile(t.file, 'utf8');
  } catch (e) {
    return `读取失败：${e.message}`;
  }
  if (!text.trim()) return '文件为空';

  try {
    if (t.kind === 'yaml') {
      const obj = tryParseYaml(text);
      if (!obj || typeof obj !== 'object') return 'YAML 结构非法：期望键值对象';
      return null;
    }
    const json = JSON.parse(text);
    if (json === null || typeof json !== 'object') return 'JSON 结构非法：期望对象';
    if (t.kind === 'name' || t.kind === 'used') {
      if (!Array.isArray(json)) return 'JSON 结构非法：期望数组';
    } else if (t.kind === 'lang') {
      const keys = Object.keys(json);
      if (!keys.length) return '语言包为空对象';
      const required = ['app.title', 'stat.kanji'];
      const missing = required.filter((k) => !(k in json));
      if (missing.length) return `语言包缺少关键字段：${missing.join('、')}`;
    }
    return null;
  } catch (e) {
    return `解析失败：${e.message}`;
  }
}

/**
 * 扫描配置文件，返回异常清单。
 * @param {string} root 项目/数据根目录（开发模式 process.cwd()，打包后为可写数据目录）
 * @returns {Promise<Array<{path:string, rel:string, kind:string, reason:string}>>}
 */
export async function detectConfigIssues(root = process.cwd(), langDir = null) {
  const targets = await buildTargets(root, langDir || getLangDir());

  // 动态加入各数据批次的 name.json / used.json
  const namesDir = path.join(root, 'data', 'names_data');
  try {
    const batches = await fs.readdir(namesDir, { withFileTypes: true });
    for (const b of batches) {
      if (!b.isDirectory()) continue;
      targets.push({ file: path.join(namesDir, b.name, 'name.json'), kind: 'name' });
      targets.push({ file: path.join(namesDir, b.name, 'used.json'), kind: 'used' });
    }
  } catch { /* names_data 不存在则跳过 */ }

  const issues = [];
  for (const t of targets) {
    const reason = await checkOne(t);
    if (reason) {
      issues.push({
        path: t.file,
        rel: path.relative(root, t.file).split(path.sep).join('/'),
        kind: t.kind,
        reason,
      });
    }
  }
  return issues;
}

/**
 * 将异常文件隔离：重命名为 `原名_error_<毫秒时间戳>`，使其脱离加载路径。
 * @param {Array<{path:string, kind:string}>} issues detectConfigIssues 的产出
 * @returns {Promise<Array<{original:string, renamed:string, ok:boolean, error?:string}>>}
 */
export async function isolateIssues(issues = []) {
  const ts = Date.now();
  const results = [];
  for (const it of issues) {
    // 语言包异常由加载器从内置表自动恢复（复制回本地），不参与重命名隔离
    if (it.kind === 'lang') {
      results.push({ original: it.path, ok: false, skipped: true, reason: '语言包异常由内置表自动恢复' });
      continue;
    }
    try {
      const dir = path.dirname(it.path);
      const base = path.basename(it.path);
      const renamed = path.join(dir, `${base}_error_${ts}`);
      await fs.rename(it.path, renamed);
      results.push({ original: it.path, renamed, ok: true });
    } catch (e) {
      results.push({ original: it.path, ok: false, error: e.message });
    }
  }
  return results;
}
