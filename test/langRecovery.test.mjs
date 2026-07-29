import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { BUILTIN_CODES, BUILTIN_LANGS } from '../src/store/builtinLang.js';
import { sanitizeLangCode, LOCALE_RE, isValidLangFile } from '../src/store/langPaths.js';

let pass = 0;
function ok(name) { pass++; console.log(`✓ ${name}`); }

// 复刻 main.js 中 lang-load / lang-list 的恢复语义，验证「内置语言异常→复制回本地；其他语言→不采取任何措施」
// 关键：使用真实 langPaths 的 sanitizeLangCode / LOCALE_RE / isValidLangFile 做净化与格式校验
async function langLoad(code, langDir) {
  const raw = sanitizeLangCode(code || 'zh-CN');
  const c = LOCALE_RE.test(raw) ? raw : 'zh-CN';
  const file = path.join(langDir, `${c}.json`);
  try {
    return { ok: true, json: JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch {
    if (BUILTIN_CODES.includes(c)) {
      await fs.mkdir(langDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(BUILTIN_LANGS[c], null, 2), 'utf8');
      return { ok: true, json: BUILTIN_LANGS[c], recovered: true };
    }
    return { ok: false, json: null }; // 其他语言：跳过
  }
}

async function langList(langDir) {
  let files = [];
  try { files = await fs.readdir(langDir); } catch { files = []; }
  const langs = [];
  for (const f of files) {
    if (!isValidLangFile(f)) continue; // 仅接受 i18n 命名，过滤无关 .json
    const code = f.slice(0, -5);
    const file = path.join(langDir, f);
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      langs.push({ code, language: json.language || code });
    } catch {
      if (BUILTIN_CODES.includes(code)) {
        await fs.mkdir(langDir, { recursive: true });
        await fs.writeFile(file, JSON.stringify(BUILTIN_LANGS[code], null, 2), 'utf8');
        langs.push({ code, language: BUILTIN_LANGS[code].language || code, recovered: true });
      }
      // 其他语言异常 → 跳过
    }
  }
  return langs;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'langrec-'));
try {
  // 1) 内置语言 zh-CN 文件损坏 → 从内置表复制到本地并重载
  await fs.writeFile(path.join(tmp, 'zh-CN.json'), '{ broken');
  const r1 = await langLoad('zh-CN', tmp);
  assert(r1.ok && r1.recovered, 'zh-CN 损坏应被内置表恢复');
  assert(r1.json.language === '中文简体', '恢复后的 zh-CN 应含 language=中文简体');
  const reread = JSON.parse(await fs.readFile(path.join(tmp, 'zh-CN.json'), 'utf8'));
  assert(reread.language === '中文简体', '恢复后本地文件应已写入内置表');
  ok('zh-CN 异常从内置表复制回本地并重载');

  // 2) 其他语言 fr 损坏 → 不采取任何措施（返回空，文件不被创建）
  const r2 = await langLoad('fr', tmp);
  assert(!r2.ok && r2.json === null, 'fr（非内置）损坏应返回空、不处理');
  let frExists = true;
  try { await fs.stat(path.join(tmp, 'fr.json')); } catch { frExists = false; }
  assert(!frExists, 'fr 损坏不应生成任何文件');
  ok('其他语言异常不采取任何措施');

  // 3) 用户新增合法语言 fr.json → lang-list 正常列出其 language
  await fs.writeFile(path.join(tmp, 'fr.json'), JSON.stringify({ language: 'Français', 'app.title': 'Test' }, null, 2));
  const list = await langList(tmp);
  const fr = list.find((l) => l.code === 'fr');
  assert(fr && fr.language === 'Français', '用户新增 fr 应被列出，显示 Français');
  const zh = list.find((l) => l.code === 'zh-CN');
  assert(zh && zh.language === '中文简体', 'zh-CN 应被列出');
  ok('支持加载用户以 i18n 命名放入的其他语言文件');

  // 4) 用户新增语言 de.json 损坏（非内置）→ lang-list 跳过，不列出
  await fs.writeFile(path.join(tmp, 'de.json'), '{ bad');
  const list2 = await langList(tmp);
  assert(!list2.some((l) => l.code === 'de'), '损坏的非内置 de 不应被列出');
  ok('损坏的非内置语言在列表中跳过');

  // 5) en 损坏 → 同样从内置表恢复
  await fs.writeFile(path.join(tmp, 'en.json'), '???');
  const r5 = await langLoad('en', tmp);
  assert(r5.ok && r5.recovered && r5.json.language === 'English', 'en 损坏应从内置表恢复为 English');
  ok('en 异常从内置表复制回本地');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

// ─── 6) 严格 i18n 命名：同时兼容 - 与 _ 分隔，识别 hi_IN 这类其他 i18n 名称 ───
const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'langname-'));
try {
  // 6a) 命名格式校验（纯函数，不依赖文件系统）
  assert(isValidLangFile('zh-CN.json'), 'zh-CN.json 应通过校验');
  assert(isValidLangFile('hi_IN.json'), 'hi_IN.json（下划线分隔）应通过校验');
  assert(isValidLangFile('zh_TW.json'), 'zh_TW.json（下划线分隔）应通过校验');
  assert(isValidLangFile('en.json'), 'en.json 应通过校验');
  assert(isValidLangFile('zh-Hans-CN.json'), 'zh-Hans-CN.json（带 script 子标签）应通过校验');
  assert(isValidLangFile('es-419.json'), 'es-419.json（3 位数字 region）应通过校验');
  assert(!isValidLangFile('notes.json'), 'notes.json（非 locale 命名）应被拒绝');
  assert(!isValidLangFile('README.json'), 'README.json 应被拒绝');
  assert(!isValidLangFile('zh-CN.txt'), '.txt 应被拒绝');
  ok('i18n 语言文件名格式校验正确（兼容 - 与 _ 分隔）');

  // 6b) 净化保留下划线：hi_IN 不应被改写成 hiIN；标点被剔除但分隔符保留
  assert(sanitizeLangCode('hi_IN') === 'hi_IN', 'sanitizeLangCode 应保留下划线');
  assert(sanitizeLangCode('hi_IN!') === 'hi_IN', 'sanitizeLangCode 应剔除标点但保留 _');
  assert(sanitizeLangCode('zh-CN') === 'zh-CN', 'sanitizeLangCode 应保留连字符');
  assert(sanitizeLangCode('zh CN') === 'zhCN', 'sanitizeLangCode 应剔除空格（无分隔符）');
  ok('sanitizeLangCode 保留 locale 分隔符（_ 与 -）');

  // 6c) 用户新增 hi_IN.json（下划线命名）→ 既能加载也能在列表中识别
  await fs.writeFile(path.join(tmp2, 'hi_IN.json'),
    JSON.stringify({ language: 'हिन्दी (भारत)', 'app.title': 'Test Hi' }, null, 2));
  const r = await langLoad('hi_IN', tmp2);
  assert(r.ok && r.json.language === 'हिन्दी (भारत)', 'hi_IN 应被正常加载（下划线未丢失）');
  const list3 = await langList(tmp2);
  const hi = list3.find((l) => l.code === 'hi_IN');
  assert(hi && hi.language === 'हिन्दी (भारत)', 'hi_IN 应出现在语言列表中');
  ok('用户以 i18n 命名（hi_IN.json）放入的语言可被识别与加载');

  // 6d) 非 i18n 命名的 .json（如 notes.json）即便放入也不被当作语言包
  await fs.writeFile(path.join(tmp2, 'notes.json'), JSON.stringify({ foo: 1 }));
  const list4 = await langList(tmp2);
  assert(!list4.some((l) => l.code === 'notes'), 'notes.json 不应出现在语言列表');
  ok('非 i18n 命名的 .json 被忽略');
} finally {
  await fs.rm(tmp2, { recursive: true, force: true });
}

console.log(`\n语言包回退与动态加载测试全部通过 ✅ (${pass} 项)`);
