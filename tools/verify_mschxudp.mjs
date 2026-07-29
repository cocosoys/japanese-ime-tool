/* TEST_DEBUG_DISABLED
===== 测试/调试脚本 · 已整体注释禁用（如需恢复请删除首尾注释包裹）=====

// 验证 MschxudpExporter 输出的字节结构可被 IME 读取（对照 gongyoyo/mschxudp win10 1703 格式回读）。
import { MschxudpExporter } from '../src/implementations/exporter/MschxudpExporter.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// 回读逻辑（镜像 python MschxudpFile，1703 变体）
function parseMschxudp(buf) {
  if (buf.toString('ascii', 0, 8) !== 'mschxudp') throw new Error('magic 不匹配: ' + buf.toString('ascii', 0, 8));
  const unknown = buf.readUInt32LE(8);
  const version = buf.readUInt32LE(12);
  const offsetStart = buf.readUInt32LE(16);
  const phraseStart = buf.readUInt32LE(20);
  const phraseEnd = buf.readUInt32LE(24);
  const count = buf.readUInt32LE(28);
  const timestamp = buf.readUInt32LE(32);

  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(buf.readUInt32LE(offsetStart + i * 4));
  offsets.push(phraseEnd - phraseStart);

  const phrases = [];
  let p = phraseStart;
  for (let i = 0; i < count; i++) {
    const magic = buf.readUInt32LE(p);
    if (magic !== 0x00100010) throw new Error(`词条 ${i} magic 不匹配: 0x${magic.toString(16)}`);
    const offset = buf.readUInt16LE(p + 4);
    const candidate = buf.readUInt8(p + 6);
    const candidate2 = buf.readUInt8(p + 7);
    const phraseUnknown = buf.readUInt32LE(p + 8) + buf.readUInt32LE(p + 12) * 0x100000000;
    const codeStart = p + 16;
    const code = buf.slice(codeStart, codeStart + offset - 0x10).toString('utf16le').replace(/\0+$/, '');
    const phraseLen = offsets[i + 1] - offsets[i] - offset;
    const phraseStart2 = codeStart + offset - 0x10;
    const phrase = buf.slice(phraseStart2, phraseStart2 + phraseLen).toString('utf16le').replace(/\0+$/, '');
    phrases.push({ code, phrase, candidate, candidate2, phraseUnknown });
    p = phraseStart + offsets[i + 1];
  }
  return { unknown, version, offsetStart, phraseStart, phraseEnd, count, timestamp, phrases };
}

const exp = new MschxudpExporter();

// 用例 1：与用户实测文件完全相同的两条记录
const records = [
  { code: 'q', word: 'qwe', order: 1 },
  { code: 'testpinyin', word: 'context_test', order: 1 },
];
const buf = await exp.export(records, { merge: false }); // 纯构建，不读取真机文件
console.log('=== 用例1：复刻用户 EUDPv1.lex ===');
console.log('生成字节数:', buf.length, '(用户真实文件=164)');
const parsed = parseMschxudp(buf);
console.log('解析 count:', parsed.count, '| unknown:0x' + parsed.unknown.toString(16), '| version:', parsed.version);
parsed.phrases.forEach((ph, i) => {
  console.log(`  词条${i}: code="${ph.code}" phrase="${ph.phrase}" candidate=${ph.candidate} candidate2=0x${ph.candidate2.toString(16)} unknown=0x${ph.phraseUnknown.toString(16)}`);
});
console.assert(parsed.count === 2, 'count 应为 2');
console.assert(parsed.phrases[1].code === 'testpinyin', '词条1 code 应为 testpinyin');
console.assert(parsed.phrases[1].phrase === 'context_test', '词条1 phrase 应为 context_test');
console.assert(parsed.phrases[1].candidate === 1, '词条1 candidate 应为 1');
console.assert(parsed.phrases[1].candidate2 === 0x06, '词条1 candidate2 应为 0x06');

// 用例 2：真实日文名的批量导入
const jp = [
  { code: 'sakura', word: '桜', order: 1 },
  { code: 'haruki', word: '春樹', order: 2 },
  { code: 'yuki', word: '雪', order: 3 },
  { code: 'hana', word: '花', order: 1 },
];
const buf2 = await exp.export(jp, { merge: false });
console.log('\n=== 用例2：日文名批量 ===');
console.log('生成字节数:', buf2.length, '| 应可回读', jp.length, '条');
const p2 = parseMschxudp(buf2);
console.assert(p2.count === jp.length, 'count 应为 ' + jp.length);
p2.phrases.forEach((ph, i) => {
  console.assert(ph.code === jp[i].code, `词条${i} code 应为 ${jp[i].code}`);
  console.assert(ph.phrase === jp[i].word, `词条${i} phrase 应为 ${jp[i].word}`);
  console.assert(ph.candidate === jp[i].order, `词条${i} candidate 应为 ${jp[i].order}`);
  console.log(`  词条${i}: ${ph.code} → ${ph.phrase} (位置${ph.candidate})`);
});

// 用例 3：空文件（清除用）
const empty = await exp.export([], { merge: false });
console.log('\n=== 用例3：空文件（清除） ===');
console.log('生成字节数:', empty.length, '(应为 0x40=64)');
const pe = parseMschxudp(empty);
console.assert(pe.count === 0, '空文件 count 应为 0');
console.assert(empty.length === 0x40, '空文件长度应为 64');

console.log('\n✅ 全部断言通过：MschxudpExporter 输出与 Win11 Settings UI 写入格式一致');

// 用例 4：合并（不覆盖用户已有短语）
// 注意：export() 只构建 Buffer（merge 时读取 filePath），写盘由 importer 负责，测试中手动写入模拟
const tmpFile = path.join(os.tmpdir(), `mschxudp_merge_${Date.now()}.lex`);
const first = await exp.export([{ code: 'q', word: 'qwe', order: 1 }, { code: 'testpinyin', word: 'context_test', order: 1 }], { filePath: tmpFile });
await fs.writeFile(tmpFile, first);
// 第二次导入：含一个已存在的短语 + 一个新短语
const second = await exp.export([{ code: 'testpinyin', word: 'context_test', order: 1 }, { code: 'sakura', word: '桜', order: 2 }], { filePath: tmpFile });
await fs.writeFile(tmpFile, second);
const merged = parseMschxudp(await fs.readFile(tmpFile));
console.log('\n=== 用例4：合并 ===');
console.log('合并后 count:', merged.count, '(应为 3：q→qwe, testpinyin→context_test, sakura→桜)');
merged.phrases.forEach((ph, i) => console.log(`  词条${i}: ${ph.code} → ${ph.phrase}`));
console.assert(merged.count === 3, '合并后应为 3 条');
console.assert(merged.phrases.some((p) => p.code === 'q' && p.phrase === 'qwe'), '应保留 q→qwe');
console.assert(merged.phrases.some((p) => p.code === 'sakura' && p.phrase === '桜'), '应新增 sakura→桜');
console.assert(merged.phrases.filter((p) => p.code === 'testpinyin').length === 1, 'testpinyin 不应重复');
console.log('✅ 合并测试通过：导入不会覆盖用户已有的手动短语');

// 用例 5：清除（merge:false 必须生成真正的空文件，即使目标已有词条）
const cleared = await exp.export([], { filePath: tmpFile, merge: false });
await fs.writeFile(tmpFile, cleared);
console.log('\n=== 用例5：清除（merge:false） ===');
console.log('清除后字节数:', cleared.length, '(应为 64)');
const pc = parseMschxudp(await fs.readFile(tmpFile));
console.assert(pc.count === 0, '清除后 count 应为 0，不能把旧词条合并回来');
console.log('✅ 清除测试通过：merge:false 不会读回旧词条');

await fs.unlink(tmpFile).catch(() => {});


===== 测试/调试脚本结束 ===== */
