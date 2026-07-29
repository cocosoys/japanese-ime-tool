/* TEST_DEBUG_DISABLED
===== 测试/调试脚本 · 已整体注释禁用（如需恢复请删除首尾注释包裹）=====

// 与 dat-roundtrip 共用的解析校验，抽出来给 parser 测试用
import { MsPinyinDatExporter } from '../src/implementations/exporter/MsPinyinDatExporter.js';

export function parseDatCheck(buf, expected) {
  const u32 = (o) => buf.readUInt32LE(o);
  const offsetStart = u32(0x10);
  const entryStart = u32(0x14);
  const entryEnd = u32(0x18);
  const count = u32(0x1c);
  const results = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    let length, next;
    if (i === count - 1) length = entryEnd - entryStart - offset;
    else { next = u32(offsetStart + 4 * (i + 1)); length = next - offset; }
    const base = entryStart + offset;
    const codeLen = buf.readUInt16LE(base + 4);
    const codeBytesLen = codeLen - 0x12;
    const code = buf.toString('utf16le', base + 16, base + 16 + codeBytesLen);
    const word = buf.toString('utf16le', base + codeLen, base + length - 2);
    results.push({ code, word });
    if (i !== count - 1) offset = next;
  }
  // 只比 code/word（order 由调用方保证）
  for (let i = 0; i < expected.length; i++) {
    if (results[i].code !== expected[i].code || results[i].word !== expected[i].word) {
      throw new Error(`第 ${i} 条不符: ${JSON.stringify(results[i])} vs ${JSON.stringify(expected[i])}`);
    }
  }
  return results;
}


===== 测试/调试脚本结束 ===== */
