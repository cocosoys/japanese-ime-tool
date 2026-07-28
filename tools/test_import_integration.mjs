// 集成测试：ImportService → MsPinyinImporter 全链路（使用临时 APPDATA，不触碰真实 IME）。
// reloadIme 被 mock，避免真正杀死 ChsIME 进程。
import { ImportService } from '../src/services/ImportService.js';
import { ImportConfig } from '../src/entities/ImportConfig.js';
import { NameEntry } from '../src/entities/NameEntry.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ime-test-'));
process.env.APPDATA = tmpDir;
console.log('临时 APPDATA:', tmpDir);

const service = new ImportService();
service.importer.reloadIme = async () => ({ killedChsIME: true, method: 'test-mock' });

// 复刻用户测试短语 + 一个日文名
const rawEntries = [
  { kanji: '桜', romaji: 'sakura', hiragana: 'さくら', raw: '桜' },
  { kanji: '春樹', romaji: 'haruki', hiragana: 'はるき', raw: '春樹' },
  { kanji: '雪', romaji: 'yuki', hiragana: 'ゆき', raw: '雪' },
];
const entries = rawEntries.map((e) => NameEntry.fromJSON(e));
const config = new ImportConfig({ count: 3, phraseField: 'kanji', bindingStrategy: 'romaji', orderValue: 2, orderMode: 'fixed', lockedBindings: {} });

const res = await service.import(entries, config, {});
const chs = path.join(tmpDir, 'Microsoft', 'InputMethod', 'Chs');
console.log('\n=== import 结果 ===');
console.log('主目标:', res.target);
console.log('eudp:', res.eudpTarget);
console.log('udl :', res.udlTarget);
console.log('legacy:', res.legacyTarget);
console.log('records:', res.records.length);
console.log('backups:', JSON.stringify(res.backups));
// 固定模式：所有短语候选位置应统一为 orderValue
console.assert(res.records.every((r) => r.order === 2), '固定模式：所有短语候选位置应统一为 orderValue=2');
console.log('固定模式 orderValue 校验：全部 =', res.records[0].order);

// 验证三个文件都写入了
for (const f of ['ChsPinyinEUDPv1.lex', 'ChsPinyinUDL.dat', path.join('CustomPhrases', 'ChsUserPhrase.dat')]) {
  const p = path.join(chs, f);
  const ok = await fs.access(p).then(() => true).catch(() => false);
  console.log(`  文件存在 ${f}: ${ok}`);
}

// 验证 EUDPv1.lex 可回读
function parse(buf) {
  if (buf.toString('ascii', 0, 8) !== 'mschxudp') throw new Error('magic');
  const count = buf.readUInt32LE(28);
  const offStart = buf.readUInt32LE(16);
  const pStart = buf.readUInt32LE(20);
  const offs = [];
  for (let i = 0; i < count; i++) offs.push(buf.readUInt32LE(offStart + i * 4));
  offs.push(buf.readUInt32LE(24) - pStart);
  const ph = [];
  let p = pStart;
  for (let i = 0; i < count; i++) {
    const offset = buf.readUInt16LE(p + 4);
    const cand = buf.readUInt8(p + 6);
    const code = buf.slice(p + 16, p + 16 + offset - 0x10).toString('utf16le').replace(/\0+$/, '');
    const plen = offs[i + 1] - offs[i] - offset;
    const phrase = buf.slice(p + 16 + offset - 0x10, p + 16 + offset - 0x10 + plen).toString('utf16le').replace(/\0+$/, '');
    ph.push({ code, phrase, cand });
    p = pStart + offs[i + 1];
  }
  return { count, ph };
}
const lex = await fs.readFile(path.join(chs, 'ChsPinyinEUDPv1.lex'));
const parsed = parse(lex);
console.log('\nEUDPv1.lex 回读 count=', parsed.count);
parsed.ph.forEach((x, i) => console.log(`  词条${i}: ${x.code} → ${x.phrase} (位置${x.cand})`));

// 验证记录内容正确（romaji → kanji，均为位置1）
console.assert(parsed.count === 3, '应有 3 条');
console.assert(parsed.ph[0].code === 'sakura' && parsed.ph[0].phrase === '桜', '词条0 应为 sakura→桜');
console.assert(parsed.ph[2].code === 'yuki' && parsed.ph[2].phrase === '雪', '词条2 应为 yuki→雪');

// === clear ===
const clr = await service.clear();
console.log('\n=== clear ===');
console.log('originalCount:', clr.originalCount, '| target:', clr.target);
console.log('reloaded:', JSON.stringify(clr.reloaded));
const lexAfterClear = await fs.readFile(path.join(chs, 'ChsPinyinEUDPv1.lex'));
console.log('clear 后 EUDPv1.lex count =', lexAfterClear.readUInt32LE(28), '(应为 0)');
console.assert(lexAfterClear.readUInt32LE(28) === 0, 'clear 后应为空');
// clear 应同步清空 legacy（machxudp count 位于 0x1c）
const legacyAfterClear = await fs.readFile(path.join(chs, 'CustomPhrases', 'ChsUserPhrase.dat'));
console.log('clear 后 ChsUserPhrase.dat count =', legacyAfterClear.readUInt32LE(0x1c), '(应为 0)');
console.assert(legacyAfterClear.toString('ascii', 0, 8) === 'machxudp', 'legacy magic 应为 machxudp');
console.assert(legacyAfterClear.readUInt32LE(0x1c) === 0, 'clear 后 legacy 应为空');
console.assert(clr.reloaded, 'clear 应返回 reloaded 状态');

// === undo（撤回清除） ===
const und = await service.undo(clr.backups);
console.log('\n=== undo（撤回清除） ===');
console.log('target:', und.target, '| reloaded:', JSON.stringify(und.reloaded));
const lexAfterUndo = await fs.readFile(path.join(chs, 'ChsPinyinEUDPv1.lex'));
const parsedUndo = parse(lexAfterUndo);
console.log('undo 后 EUDPv1.lex count =', parsedUndo.count, '(应恢复为 3)');
parsedUndo.ph.forEach((x, i) => console.log(`  恢复词条${i}: ${x.code} → ${x.phrase}`));
console.assert(parsedUndo.count === 3, 'undo 后应恢复 3 条');
// legacy 也应恢复为导入后的 3 条
const legacyAfterUndo = await fs.readFile(path.join(chs, 'CustomPhrases', 'ChsUserPhrase.dat'));
console.assert(legacyAfterUndo.readUInt32LE(0x1c) === 3, 'undo 后 legacy 应恢复 3 条');
console.assert(und.reloaded, 'undo 应返回 reloaded 状态');

// === 场景2：全新目录首次导入 → 撤回应删除新建文件（备份为 null） ===
const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ime-test2-'));
process.env.APPDATA = tmpDir2;
const service2 = new ImportService();
service2.importer.reloadIme = async () => ({ killedChsIME: true, method: 'test-mock' });
const res2 = await service2.import(entries, config, {});
console.log('\n=== 场景2：首次导入 → 撤回 ===');
console.log('backups:', JSON.stringify(res2.backups), '(应全为 null)');
console.assert(res2.backups.eudp === null && res2.backups.udl === null && res2.backups.legacy === null, '首次导入备份应全为 null');
await service2.undo({ backups: res2.backups });
const chs2 = path.join(tmpDir2, 'Microsoft', 'InputMethod', 'Chs');
for (const f of ['ChsPinyinEUDPv1.lex', 'ChsPinyinUDL.dat', path.join('CustomPhrases', 'ChsUserPhrase.dat')]) {
  const exists = await fs.access(path.join(chs2, f)).then(() => true).catch(() => false);
  console.log(`  撤回后 ${f} 存在: ${exists} (应为 false)`);
  console.assert(!exists, `撤回后 ${f} 应被删除`);
}

// 清理临时目录
await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
await fs.rm(tmpDir2, { recursive: true, force: true }).catch(() => {});

console.log('\n✅ 集成测试全部通过');
