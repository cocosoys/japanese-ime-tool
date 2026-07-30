import { PhraseExporter } from '../../interfaces/PhraseExporter.js';

// 微软拼音/五笔「用户自定义短语」.dat 二进制生成器。
// 格式（逆向自 github.com/cxcn/dtool）：
//   头部 8 字节 magic "machxudp"
//   8 字节版本
//   5 个 uint32: 偏移表起始(0x40) | 词条体起始(0x40+4*count) | 总长(占位) | 词条数 | 导出时间戳
//   32 字节补零
//   (count-1) 个 uint32 偏移表（指向下一条词条体，相对词条体起始）
//   词条体：标记(4) | codeLen(uint16=len(code)+0x12) | order(1) | 0x06(1) | 4空 | 时间戳(4)
//           | code(UTF-16LE) | 00 00 | word(UTF-16LE) | 00 00
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

export class MsPinyinDatExporter extends PhraseExporter {
  /**
   * 解析现有 machxudp 文件（旧版自定义短语位置），返回 {code, word, candidate} 数组。
   * 格式与 mschxudp 词条体一致：magic 0x00100010 | u16(codeLen=codeChars+0x12) |
   * order(1) | 0x06(1) | 4 空 | 时间戳(4) | code(utf16) | 00 00 | word(utf16) | 00 00
   * @param {string} filePath
   * @returns {Promise<Array<{code:string, word:string, candidate:number}>>}
   */
  async parse(filePath) {
    let buf;
    try { buf = await this._readFile(filePath); } catch { return []; }
    if (!buf || buf.length < 0x40) return [];
    if (buf.toString('ascii', 0, 8) !== 'machxudp') return [];
    const count = buf.readUInt32LE(28);
    const offStart = buf.readUInt32LE(16);
    const pStart = buf.readUInt32LE(20);
    if (!offStart || !pStart) return [];
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(buf.readUInt32LE(offStart + i * 4));
    offsets.push(buf.readUInt32LE(24) - pStart);

    const out = [];
    let p = pStart;
    for (let i = 0; i < count; i++) {
      if (p + 16 > buf.length) break;
      if (buf.readUInt32LE(p) !== 0x00100010) break;
      const codeChars = buf.readUInt16LE(p + 4) - 0x12;
      const order = buf.readUInt8(p + 6);
      if (codeChars < 0) break;
      const codeBytes = codeChars * 2;
      const code = buf.slice(p + 16, p + 16 + codeBytes).toString('utf16le');
      const wordStart = p + 16 + codeBytes + 2;            // 跳过 code 后的 00 00
      const wordBytes = (offsets[i + 1] - offsets[i]) - 16 - codeBytes - 4;
      if (wordBytes < 0) break;
      const word = buf.slice(wordStart, wordStart + wordBytes).toString('utf16le');
      out.push({ code, word, candidate: order });
      p = pStart + offsets[i + 1];
    }
    return out;
  }

  /** 读取文件（小封装，便于测试注入） */
  async _readFile(fp) {
    const fs = await import('fs');
    return fs.promises.readFile(fp);
  }

  /** @param {Array<{code:string, word:string, order?:number}>} records */
  export(records) {
    const stamp = Math.floor(Date.now() / 1000) >>> 0;
    const count = records.length;

    const bodies = [];
    const offsets = []; // 仅 count-1 项
    let cumulative = 0;

    for (let i = 0; i < count; i++) {
      const codeStr = (records[i].code || '').normalize('NFC');
      const code = Buffer.from(codeStr, 'utf16le');
      const word = Buffer.from((records[i].word || '').normalize('NFC'), 'utf16le');
      const order = (records[i].order ?? (i + 1)) & 0xff;

      const entry = Buffer.concat([
        Buffer.from([0x10, 0x00, 0x10, 0x00]),
        u16(codeStr.length + 0x12),
        Buffer.from([order, 0x06]),
        Buffer.alloc(4),
        u32(stamp),
        code,
        Buffer.from([0x00, 0x00]),
        word,
        Buffer.from([0x00, 0x00]),
      ]);

      bodies.push(entry);
      if (i !== count - 1) {
        cumulative += entry.length;
        offsets.push(cumulative);
      }
    }

    const entryStart = 0x40 + 4 * count;
    const header = Buffer.concat([
      Buffer.from([0x6d, 0x61, 0x63, 0x68, 0x78, 0x75, 0x64, 0x70]), // machxudp
      Buffer.from([0x02, 0x00, 0x60, 0x00, 0x01, 0x00, 0x00, 0x00]), // version
      u32(0x40),        // 偏移表起始
      u32(entryStart),  // 词条体起始
      u32(0),           // 总长占位
      u32(count),       // 词条数
      u32(stamp),       // 导出时间戳
    ]);
    const padding = Buffer.alloc(32); // 28 + 4 补零
    const offsetBuf = Buffer.concat(offsets.map(u32));

    const out = Buffer.concat([header, padding, offsetBuf, ...bodies]);
    out.writeUInt32LE(out.length >>> 0, 0x18); // 回填总长
    return out;
  }
}
