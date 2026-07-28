import assert from 'assert';
import { MsPinyinDatExporter } from '../src/implementations/exporter/MsPinyinDatExporter.js';

// 把生成的 .dat 解析回来，验证二进制格式正确（逆向自 dtool Parse）
function parseDat(buf) {
  const u32 = (o) => buf.readUInt32LE(o);
  const magic = buf.toString('latin1', 0, 8);
  assert.strictEqual(magic, 'machxudp', 'magic 校验失败');
  const offsetStart = u32(0x10);
  const entryStart = u32(0x14);
  const entryEnd = u32(0x18);
  const count = u32(0x1c);
  const results = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    let length, next;
    if (i === count - 1) {
      length = entryEnd - entryStart - offset;
    } else {
      next = u32(offsetStart + 4 * (i + 1));
      length = next - offset;
    }
    const base = entryStart + offset;
    const codeLen = buf.readUInt16LE(base + 4);
    const order = buf.readUInt8(base + 6);
    const codeBytesLen = codeLen - 0x12;
    const code = buf.toString('utf16le', base + 16, base + 16 + codeBytesLen);
    const word = buf.toString('utf16le', base + codeLen, base + length - 2);
    results.push({ code, word, order });
    if (i !== count - 1) offset = next;
  }
  return results;
}

function run(label, records) {
  const buf = new MsPinyinDatExporter().export(records);
  const back = parseDat(buf);
  assert.strictEqual(back.length, records.length, `${label}: 数量不符`);
  assert.deepStrictEqual(back, records, `${label}: 内容不符`);
  console.log(`✓ ${label} (${records.length} 条, ${buf.length} 字节)`);
}

// 1) 常规多条
run('多词条', [
  { code: 'yuki', word: '雪', order: 1 },
  { code: 'sakura', word: '桜', order: 2 },
  { code: 'haruki', word: '春樹', order: 3 },
]);

// 2) 单条（边界）
run('单词条', [{ code: 'aoi', word: '葵', order: 1 }]);

// 3) 较多条 + 长汉字
run('多词条-长名', Array.from({ length: 20 }, (_, i) => ({
  code: `name${i + 1}`,
  word: `日本の名前サンプル${i + 1}`,
  order: i + 1,
})));

console.log('\n全部 .dat 往返校验通过 ✅');
