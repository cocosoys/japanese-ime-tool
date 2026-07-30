import { promises as fs } from 'fs';
import { PhraseExporter } from '../../interfaces/PhraseExporter.js';

/**
 * 微软拼音 Win11 23H2+ 用户词典（UDL）格式导出器。
 *
 * 目标文件：%APPDATA%\Microsoft\InputMethod\Chs\ChsPinyinUDL.dat
 * 格式标识：0x55AA8881（小端读取为 0x8188AA55；磁盘字节序为 55 AA 88 81）
 *
 * 文件结构：
 *   [0x00-0x03] Magic: 55 AA 88 81  （writeUInt32BE(0x55AA8881)）
 *   [0x04-0x07] 字段=0x00600002（字节 02 00 60 00）
 *   [0x08-0x0B] 校验: AA 55 AA 55
 *   [0x0C-0x0F] 词条总数 (uint32 LE)
 *   [0x10-0x13] 导出时间戳（实测真实文件为 0）
 *   [0x14-0x23FF] 填充零
 *   [0x2400 起] 词条数组，每条固定 60 字节：
 *     +0  插入时间戳 (4B uint32 LE)
 *     +4  简码/触发码 (3B) — 用户绑定的触发字符串（如 "q"），超长截断为前 3 字节
 *     +7  保留 (3B) — 真实文件中取值不定，新条目统一用 [0,0,0]
 *     +10 词长 (1B) — 汉字字数（UTF-16LE 字符数）
 *     +11 分隔符 (1B) — 固定 0x5A
 *     +12 词内容 (wordLen*2 B) — UTF-16LE 编码的中文/日文词
 *     +12+wordLen*2 ~ +59 拼音索引 (每字 2B uint16 LE)，全 0 即可（按简码触发）
 */
export class MspyUdlExporter extends PhraseExporter {
  constructor() {
    super();
  }

  /**
   * 生成或追加到 ChsPinyinUDL.dat（合并已有词条，按词去重）。
   *
   * @param {Array<{code:string, word:string, order?:number}>} records
   * @param {object} [opts]
   * @param {string} [opts.filePath] - 目标 .dat 路径（默认自动检测）
   * @returns {Promise<Buffer>} 完整的 UDL 文件 Buffer
   */
  async export(records, { filePath } = {}) {
    const targetPath = filePath || this._defaultPath();
    const existingBuf = await this._readExisting(targetPath);
    const existingEntries = existingBuf ? this._parseEntries(existingBuf) : [];

    // 新条目的保留字节沿用文件中第一条已有条目（保持与系统文件一致），否则用 [0,0,0]
    const reserved = existingEntries.length
      ? existingEntries[0].raw.slice(7, 10)
      : Buffer.from([0x00, 0x00, 0x00]);

    const existingWords = new Set(existingEntries.map((e) => e.word));
    const newEntries = [];
    for (const r of records) {
      let word = r.word || '';
      let code = (r.code || '').toLowerCase();
      if (!word) continue;               // 空词跳过
      if (!code) continue;               // 空码跳过（Settings UI 无法编辑无触发码的词条）
      // NFC 规范化（与 mschxudp 保持一致，避免编码差异）
      word = word.normalize('NFC');
      code = code.normalize('NFC');
      if (existingWords.has(word)) continue; // 去重：已存在则不重复添加
      newEntries.push(this._makeEntry(r, reserved, code, word));
      existingWords.add(word);
    }

    // 合并：已有原始 60 字节 + 新条目
    const merged = [...existingEntries.map((e) => e.raw), ...newEntries];
    return this._buildUdl(merged);
  }

  // ── 内部方法 ──

  _defaultPath() {
    const base = process.env.APPDATA || '';
    return `${base}\\Microsoft\\InputMethod\\Chs\\ChsPinyinUDL.dat`;
  }

  /** 尝试读取现有 UDL 文件，失败返回 null */
  async _readExisting(fp) {
    try {
      return await fs.readFile(fp);
    } catch { return null; }
  }

  /** 解析现有 UDL 文件中的词条（保留每条原始 60 字节） */
  _parseEntries(buf) {
    if (buf.length < 0x2400) return [];
    if (buf.toString('hex', 0, 4) !== '55aa8881') return []; // 磁盘字节序 55 AA 88 81
    const count = buf.readUInt32LE(0x0c);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const off = 0x2400 + i * 60;
      if (off + 60 > buf.length) break;
      const wl = buf[off + 10];                       // 词长（字符数）
      const wordBytes = buf.slice(off + 12, off + 12 + wl * 2);
      entries.push({
        word: wordBytes.toString('utf16le'),
        raw: buf.slice(off, off + 60),
      });
    }
    return entries;
  }

  /** 从 60 字节原始条目中提取触发码（简码，位于 +4~+6，遇 0 终止） */
  _codeFromRaw(raw) {
    let code = '';
    for (let i = 4; i < 7 && i < raw.length; i++) {
      const c = raw[i];
      if (c === 0) break;
      code += String.fromCharCode(c);
    }
    return code;
  }

  /**
   * 解析现有 UDL 文件并返回 {code, word, raw} 数组（公开方法，供单条短语增删使用）。
   * @param {string} filePath
   * @returns {Promise<Array<{code:string, word:string, raw:Buffer}>>}
   */
  async parseEntriesWithCode(filePath) {
    const buf = await this._readExisting(filePath);
    if (!buf) return [];
    return this._parseEntries(buf).map((e) => ({ ...e, code: this._codeFromRaw(e.raw) }));
  }

  /** 由一组原始 60 字节条目构建完整 UDL 文件 Buffer（merge:false 语义，用于删除场景） */
  buildFromRaws(raws) {
    return this._buildUdl(raws);
  }

  /** 读取现有文件并合并（保留用户已有短语），返回完整 UDL Buffer；供单条短语新增使用 */
  async exportMerge(records, filePath) {
    return this.export(records, { filePath });
  }

  /** 将 {code, word} 记录转为 UDL 60 字节条目（code/word 已做 NFC 规范化） */
  _makeEntry(record, reserved, normalizedCode, normalizedWord) {
    const word = normalizedWord || (record.word || '').normalize('NFC');
    const code = normalizedCode || (record.code || '').toLowerCase().normalize('NFC');
    const wordBuf = Buffer.from(word, 'utf16le');
    const wordLen = wordBuf.length / 2;               // UTF-16LE 每字符 2 字节
    const epoch = Math.floor(Date.now() / 1000) >>> 0; // 当前时间戳（uint32）

    const entry = Buffer.alloc(60);                   // 其余字节默认 0（含拼音索引）
    entry.writeUInt32LE(epoch, 0);                    // +0 插入时间戳

    // +4 简码/触发码：绑定字符串的前 3 字节（IME 按此码触发）
    for (let i = 0; i < 3 && i < code.length; i++) {
      entry[4 + i] = code.charCodeAt(i) & 0xff;
    }

    // +7 保留（3B）
    reserved.copy(entry, 7);

    // +10 词长（1B）
    entry[10] = wordLen & 0xff;
    // +11 分隔符 0x5A
    entry[11] = 0x5a;
    // +12 词内容
    wordBuf.copy(entry, 12);

    // +12+wordLen*2 起为拼音索引区，全 0 即可（触发依赖简码，不依赖拼音）
    return entry;
  }

  /** 构建完整的 UDL 文件 Buffer */
  _buildUdl(entries) {
    const count = entries.length;

    // 头部 (0x2400 字节)
    const header = Buffer.alloc(0x2400);
    header.writeUInt32BE(0x55AA8881, 0);   // Magic 字节序 = 55 AA 88 81
    header.writeUInt32LE(0x00600002, 4);   // 字段（字节 02 00 60 00）
    header.writeUInt32LE(0xAA55AA55, 8);   // 校验
    header.writeUInt32LE(count, 0x0c);     // 词条总数
    header.writeUInt32LE(0, 0x10);         // 导出时间戳（与真实文件一致 = 0）

    // 数据区：拼接所有 60 字节条目
    const data = Buffer.concat(entries);
    return Buffer.concat([header, data]);
  }
}
