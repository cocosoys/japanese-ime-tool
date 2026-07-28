import { promises as fs } from 'fs';
import path from 'path';
import { PhraseExporter } from '../../interfaces/PhraseExporter.js';

// 微软拼音/五笔「用户自定义短语」ChsPinyinEUDPv1.lex 二进制生成器。
// 格式（逆向自 github.com/gongyoyo/mschxudp 并对照 Win11 Settings UI 实测，win10 1703+ 变体）：
//
//   头部 (0x24 字节):
//     8 字节 magic "mschxudp"
//     4 字节 unknown = 0x00600002
//     4 字节 version = 1
//     4 字节 偏移表起始 (固定 0x40)
//     4 字节 词条体起始 (0x40 + 4 * count)
//     4 字节 文件总长
//     4 字节 词条数 count
//     4 字节 导出时间戳
//     28 字节补零 (直到 0x40)
//   偏移表: count 个 uint32（每条词条的累计偏移，相对词条体起始；最后一条的总长不写入）
//   词条体: 每条
//     4 字节 magic = 0x00100010
//     2 字节 offset = 0x10 + len(pinyin_utf16)   (pinyin_utf16 含结尾 \0)
//     1 字节 candidate   （候选位置，1 起）
//     1 字节 candidate2  （实测 Settings UI 固定为 0x06）
//     8 字节 phrase_unknown（实测 Settings UI 写为 0，此处保持 0）
//     pinyin: utf-16le + \0
//     phrase: utf-16le + \0
//
// 导出时读取现有文件并合并（按 code+word 去重），避免覆盖用户已在 Settings 中手动添加的短语。

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function u64(n) {
  const b = Buffer.alloc(8);
  const v = BigInt(n);
  b.writeUInt32LE(Number(v & 0xffffffffn), 0);
  b.writeUInt32LE(Number((v >> 32n) & 0xffffffffn), 4);
  return b;
}

export class MschxudpExporter extends PhraseExporter {
  _defaultPath() {
    const base = process.env.APPDATA || '';
    return path.join(base, 'Microsoft', 'InputMethod', 'Chs', 'ChsPinyinEUDPv1.lex');
  }

  /** 解析现有 mschxudp 文件（win10 1703 变体），返回词条数组 */
  _parse(buf) {
    if (!buf || buf.length < 0x24) return [];
    if (buf.toString('ascii', 0, 8) !== 'mschxudp') return [];
    const count = buf.readUInt32LE(28);
    const offStart = buf.readUInt32LE(16);
    const pStart = buf.readUInt32LE(20);
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(buf.readUInt32LE(offStart + i * 4));
    offsets.push(buf.readUInt32LE(24) - pStart);

    const out = [];
    let p = pStart;
    for (let i = 0; i < count; i++) {
      if (p + 16 > buf.length) break;
      const magic = buf.readUInt32LE(p);
      if (magic !== 0x00100010) break;
      const offset = buf.readUInt16LE(p + 4);
      const candidate = buf.readUInt8(p + 6);
      const candidate2 = buf.readUInt8(p + 7);
      const phraseUnknown = buf.readUInt32LE(p + 8) + buf.readUInt32LE(p + 12) * 0x100000000;
      const code = buf.slice(p + 16, p + 16 + offset - 0x10).toString('utf16le').replace(/\0+$/, '');
      const plen = offsets[i + 1] - offsets[i] - offset;
      if (plen < 0) break;
      const phrase = buf.slice(p + 16 + offset - 0x10, p + 16 + offset - 0x10 + plen).toString('utf16le').replace(/\0+$/, '');
      out.push({ code, word: phrase, candidate, candidate2, phraseUnknown });
      p = pStart + offsets[i + 1];
    }
    return out;
  }

  /**
   * 读取现有 EUDPv1.lex 文件并返回解析后的词条数组（公开方法，供冲突检测使用）。
   * @param {string} [filePath] 文件路径，默认为标准路径
   * @returns {Promise<Array<{code:string, word:string, candidate:number}>>}
   */
  async parseExisting(filePath) {
    const target = filePath || this._defaultPath();
    try {
      const buf = await fs.readFile(target);
      return this._parse(buf);
    } catch {
      return [];
    }
  }

  /**
   * 对一组记录执行候选位置冲突检测与自动递增。
   *
   * @param {Array<{code:string, word:string, order?:number}>} records 待导入记录
   * @param {Array<{code:string, candidate:number}>} existing 现有词条（仅需 code + candidate）
   * @param {{maxOrder?:number}} [options]
   * @returns {{records: Array<{code:string, word:string, order:number}>, adjustments:Array<{code:string, word:string, fromOrder:number, toOrder:number}>}}
   */
  static resolveOrderConflicts(records, existing = [], { maxOrder = 20 } = {}) {
    // 构建已占用集合：Set of "code\0candidate"
    const occupied = new Set();
    for (const e of existing) {
      occupied.add(`${e.code}\u0000${e.candidate}`);
    }

    const adjustments = [];
    const resolved = [];

    for (const r of records) {
      const code = r.code || '';
      let order = r.order ?? 1;

      // 探查：从 order 开始向上找第一个未被占用的位置
      while (order <= maxOrder && occupied.has(`${code}\u0000${order}`)) {
        order++;
      }
      if (order > maxOrder) order = maxOrder; // 兜底：不超过上限

      if (r.order != null && order !== r.order) {
        adjustments.push({ code, word: r.word || '', fromOrder: r.order, toOrder: order });
      }

      // 标记占用（包括本次新增的，防止同批次内自相冲突）
      occupied.add(`${code}\u0000${order}`);

      resolved.push({ code, word: r.word || '', order });
    }

    return { records: resolved, adjustments };
  }

  /**
   * @param {Array<{code:string, word:string, order?:number}>} records
   * @param {{filePath?:string, merge?:boolean}} [options]
   *   merge=true（默认）时读取现有文件并保留用户已有短语；
   *   merge=false 时仅根据传入 records 构建（用于清除或纯字节构建）。
   */
  async export(records, { filePath, merge = true } = {}) {
    const target = filePath || this._defaultPath();

    // 读取现有文件并合并（保留用户已有的手动短语）
    let existing = [];
    if (merge) {
      try {
        const buf = await fs.readFile(target);
        existing = this._parse(buf);
      } catch { /* 文件不存在则视为空 */ }
    }

    const seen = new Set(existing.map((e) => `${e.code}\u0000${e.word}`));
    const merged = [...existing];
    for (const r of records) {
      const word = r.word || '';
      const code = r.code || '';
      if (!word) continue;
      const key = `${code}\u0000${word}`;
      if (seen.has(key)) continue;          // 已存在则不重复添加
      merged.push({
        code,
        word,
        candidate: (r.order ?? (merged.length + 1)) & 0xff,
        candidate2: 0x06,
        phraseUnknown: 0,
      });
      seen.add(key);
    }

    return this._build(merged);
  }

  /** 根据词条数组构建完整 mschxudp 文件 Buffer */
  _build(records) {
    const stamp = Math.floor(Date.now() / 1000) >>> 0;
    const count = records.length;

    const bodies = [];
    const offsets = [];
    let cumulative = 0;

    for (let i = 0; i < count; i++) {
      const code = records[i].code || '';
      const word = records[i].word || '';
      const order = (records[i].candidate ?? (i + 1)) & 0xff;
      const candidate2 = records[i].candidate2 ?? 0x06;

      const codeUtf16 = Buffer.from(code + '\0', 'utf16le');
      const wordUtf16 = Buffer.from(word + '\0', 'utf16le');
      const offset = 0x10 + codeUtf16.length;

      const entry = Buffer.concat([
        Buffer.from([0x10, 0x00, 0x10, 0x00]), // magic 0x00100010
        u16(offset),
        Buffer.from([order, candidate2]),
        u64(records[i].phraseUnknown ?? 0),    // 8 字节 phrase_unknown
        codeUtf16,
        wordUtf16,
      ]);

      bodies.push(entry);
      offsets.push(cumulative);
      cumulative += entry.length;
    }

    const phraseOffsetStart = 0x40;
    const phraseStart = phraseOffsetStart + count * 4;
    const phraseEnd = phraseStart + cumulative;

    const header = Buffer.concat([
      Buffer.from([0x6d, 0x73, 0x63, 0x68, 0x78, 0x75, 0x64, 0x70]), // "mschxudp"
      u32(0x00600002),  // unknown
      u32(1),           // version
      u32(phraseOffsetStart),
      u32(phraseStart),
      u32(phraseEnd),
      u32(count),
      u32(stamp),
    ]);
    const padding = Buffer.alloc(phraseOffsetStart - header.length); // 28 字节
    const offsetBuf = Buffer.concat(offsets.map(u32));

    return Buffer.concat([header, padding, offsetBuf, ...bodies]);
  }
}
