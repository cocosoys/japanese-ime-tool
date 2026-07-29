import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { detectConfigIssues, isolateIssues } from '../src/store/configIntegrity.js';

let pass = 0;
function ok(name) { pass++; console.log(`✓ ${name}`); }

// ---- 1. detectConfigIssues 能识别损坏的 config.yaml 与 name.json ----
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgtest-'));
try {
  await fs.mkdir(path.join(tmp, 'data'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'data', 'names_data', 'batchA'), { recursive: true });

  // config.yaml 为空（极简解析器无法产出有效键值对象，视为异常）
  await fs.writeFile(path.join(tmp, 'data', 'config.yaml'), '');
  // name.json 损坏：非法 JSON
  await fs.writeFile(path.join(tmp, 'data', 'names_data', 'batchA', 'name.json'), '{ broken json ]');
  // used.json 缺失属正常（不计入）
  // bindings.json 合法对象
  await fs.writeFile(path.join(tmp, 'data', 'bindings.json'), '{}');

  const issues = await detectConfigIssues(tmp);
  const rels = issues.map((i) => i.rel);
  assert(issues.some((i) => i.kind === 'yaml' && /config\.yaml$/.test(i.rel)), '应检测到 config.yaml 异常');
  assert(issues.some((i) => i.kind === 'name' && /name\.json$/.test(i.rel)), '应检测到 name.json 异常');
  assert(!issues.some((i) => i.kind === 'json-object' && /bindings\.json$/.test(i.rel)), '合法 bindings.json 不应报异常');
  assert(!issues.some((i) => /used\.json$/.test(i.rel)), '缺失的 used.json 不应报异常');
  ok('detectConfigIssues 正确识别损坏文件并跳过可回退缺失');

  // ---- 2. isolateIssues 将异常文件重命名为 原名_error_<毫秒时间戳> ----
  const target = issues.find((i) => i.kind === 'yaml');
  const before = await fs.stat(target.path).catch(() => null);
  assert(before, '测试前文件应存在');
  const res = await isolateIssues([target]);
  assert(res.length === 1 && res[0].ok, '隔离应成功');
  assert(/_error_\d{13}$/.test(res[0].renamed), '重命名应包含 _error_<13位毫秒时间戳>');
  const stillThere = await fs.stat(target.path).catch(() => null);
  assert(!stillThere, '原文件应已不存在（已重命名）');
  const renamedExists = await fs.stat(res[0].renamed).catch(() => null);
  assert(renamedExists, '重命名后的文件应存在');
  ok('isolateIssues 正确重命名为 原名_error_<毫秒时间戳>');

  // ---- 3. 隔离后再次检测该文件不再报异常（脱离加载路径）----
  const issues2 = await detectConfigIssues(tmp);
  assert(!issues2.some((i) => i.rel === target.rel), '隔离后原路径不应再报异常');
  ok('隔离后该文件脱离加载路径、不再被检测到');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

// ---- 4. 语言包异常不参与「隔离」重命名（交由加载器从内置表恢复）----
const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgtest2-'));
try {
  await fs.mkdir(path.join(tmp2, 'data', 'lang'), { recursive: true });
  const emptyLang = path.join(tmp2, 'data', 'lang', 'zh-CN.json');
  await fs.writeFile(emptyLang, '');
  const res = await isolateIssues([{ path: emptyLang, kind: 'lang' }]);
  assert(res[0].ok === false && res[0].skipped === true, '语言包异常应被跳过（不重命名隔离）');
  const stillThere = await fs.stat(emptyLang).catch(() => null);
  assert(stillThere, '语言包原文件应保留（交由加载器从内置表恢复）');
  ok('isolateIssues 对语言包跳过（不重命名）');
} finally {
  await fs.rm(tmp2, { recursive: true, force: true });
}

// ---- 5. 语言包检测改为按 i18n 命名动态扫描（不再写死语言码列表）----
const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgtest3-'));
const tmp3Lang = path.join(tmp3, 'data', 'lang');
try {
  await fs.mkdir(tmp3Lang, { recursive: true });
  // hi_IN.json 损坏（用户新增的 i18n 命名语言包，下划线分隔）→ 应被检测
  await fs.writeFile(path.join(tmp3Lang, 'hi_IN.json'), '');
  // zh-CN.json 合法（含必需关键字段）→ 不报错
  await fs.writeFile(path.join(tmp3Lang, 'zh-CN.json'), JSON.stringify({ language: '中文简体', 'app.title': 'x', 'stat.kanji': 'x' }));
  // notes.json 非 i18n 命名 → 不应被当作语言包
  await fs.writeFile(path.join(tmp3Lang, 'notes.json'), '');

  const issues5 = await detectConfigIssues(tmp3, tmp3Lang);
  const langIssues = issues5.filter((i) => i.kind === 'lang');
  assert(langIssues.some((i) => /hi_IN\.json$/.test(i.rel)), '用户新增的 hi_IN.json 应被检测为语言包异常');
  assert(!langIssues.some((i) => /notes\.json$/.test(i.rel)), '非 i18n 命名的 notes.json 不应被当作语言包');
  assert(!langIssues.some((i) => /zh-CN\.json$/.test(i.rel)), '合法的 zh-CN.json 不应报错');
  ok('语言包按 i18n 命名动态扫描（hi_IN.json 被识别，notes.json 被忽略）');
} finally {
  await fs.rm(tmp3, { recursive: true, force: true });
}

console.log(`\n配置文件完整性检测测试全部通过 ✅ (${pass} 项)`);
