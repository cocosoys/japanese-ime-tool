import path from 'path';
import { promises as fs } from 'fs';
import { createRequire } from 'module';

// ─── i18n 语言文件命名（严格遵循 locale 格式，兼容两种分隔符） ───
// 规则：<language>[_-]<script>?[_-]<region>?
//   - language：2~3 个小写字母（iso639）
//   - script  ：4 个字母（可选，如 Hans/Hant）
//   - region  ：2 个大写字母或 3 位数字（可选，如 CN/IN/419）
// 同时兼容 BCP-47 连字符（zh-CN）与 POSIX/Java 下划线（zh_CN / hi_IN），
// 以及 zh-Hans-CN、es-419 等带子标签的写法。
// 这样用户只要按此格式命名（如 hi_IN.json）放入 lang 目录即可被识别，无需改动代码。
export const LOCALE_RE =
  /^[a-z]{2,3}(?:[_-][A-Za-z]{4})?(?:[_-](?:[A-Za-z]{2}|[0-9]{3}))?$/;

/** 文件名 <code>.json 是否为合法的语言包命名（通过才当作可加载语言） */
export function isValidLangFile(name) {
  return typeof name === 'string' && name.endsWith('.json') && LOCALE_RE.test(name.slice(0, -5));
}

/** 仅保留 locale 允许的字符（字母/数字/连字符/下划线），其余一律剔除；不做格式校验 */
export function sanitizeLangCode(code) {
  return String(code == null ? '' : code).replace(/[^a-zA-Z0-9_-]/g, '');
}

// 语言包目录解析：
// - 开发模式：项目根 /data/lang（与现有约定一致，可直接编辑）
// - 生产模式：用户数据目录下的 lang（app.getPath('userData')/lang），始终可写、不进 asar
//   —— 满足「禁止打包文件」：语言包作为松散文件存在，用户可自行新增/修改。
//
// electron 仅在 Electron 运行时存在；用 createRequire + process.versions.electron 守卫，
// 避免纯 Node（单元测试）加载 electron 模块而报错。

const require = createRequire(import.meta.url);

function getElectronApp() {
  if (!process.versions || !process.versions.electron) return null;
  try {
    const electron = require('electron');
    return electron.app || null;
  } catch {
    return null;
  }
}

/** 可写语言包目录（运行时实际加载/回退复制的目标） */
export function getLangDir() {
  const app = getElectronApp();
  if (app && app.isPackaged) return path.join(app.getPath('userData'), 'lang');
  return path.join(process.cwd(), 'data', 'lang');
}

/** 随包分发的只读语言包目录候选（asar 内或 asarUnpack 后的松散目录） */
export function getSourceLangDirs() {
  const app = getElectronApp();
  if (!app) return [path.join(process.cwd(), 'data', 'lang')];
  const base = app.getAppPath(); // 如 .../resources/app.asar
  return [
    path.join(base, 'data', 'lang'),
    path.join(base, '..', 'app.asar.unpacked', 'data', 'lang'),
  ];
}

/**
 * 生产模式首次运行时，把随包语言包（官方语言 + 用户未新增前的全部）复制到可写目录，
 * 作为后续运行的基础；已存在的文件不覆盖。
 */
export async function ensureLangFiles() {
  const app = getElectronApp();
  if (!app || !app.isPackaged) return; // 开发模式无需复制
  const userDir = path.join(app.getPath('userData'), 'lang');
  await fs.mkdir(userDir, { recursive: true });

  for (const srcDir of getSourceLangDirs()) {
    let files = [];
    try { files = await fs.readdir(srcDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const dest = path.join(userDir, f);
      try { await fs.access(dest); continue; } catch { /* 不存在则复制 */ }
      try { await fs.copyFile(path.join(srcDir, f), dest); } catch { /* 忽略单个失败 */ }
    }
  }
}
