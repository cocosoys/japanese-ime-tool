import { createBindingStrategy } from '../implementations/binding/BindingStrategyFactory.js';
import { MspyUdlExporter } from '../implementations/exporter/MspyUdlExporter.js';
import { MsPinyinDatExporter } from '../implementations/exporter/MsPinyinDatExporter.js';
import { MschxudpExporter } from '../implementations/exporter/MschxudpExporter.js';
import { MsPinyinImporter } from '../implementations/importer/MsPinyinImporter.js';
import { ImportConfig } from '../entities/ImportConfig.js';

/**
 * 服务层：装配绑定 → 导出多格式 → 写入 IME 多路径 → 触发重载。
 *
 * Win11 23H2+ 微软拼音「用户自定义短语」存储位置：
 *   1. ChsPinyinEUDPv1.lex       — mschxudp 格式，Settings UI「用户自定义短语」真正读写文件 ★主目标
 *   2. ChsPinyinUDL.dat          — UDL 格式(0x55AA8881)，IME 引擎智能词库兜底
 *   3. CustomPhrases/ChsUserPhrase.dat — machxudp 格式，旧版自定义短语位置兜底
 *
 * 导入时三处都写入，确保无论 IME 从哪个路径读取都能生效。
 */
export class ImportService {
  constructor({ importer } = {}) {
    this.udlExporter = new MspyUdlExporter();       // UDL 格式导出器
    this.machxudpExporter = new MsPinyinDatExporter(); // machxudp 格式导出器
    this.mschxudpExporter = new MschxudpExporter();    // mschxudp 格式导出器（EUDPv1.lex）
    this.importer = importer || new MsPinyinImporter();
  }

  buildRecords(entries, config, aliases = {}) {
    const cfg = config instanceof ImportConfig ? config : new ImportConfig(config);
    const strategy = createBindingStrategy(cfg.bindingStrategy, { locked: cfg.lockedBindings });
    // 按绑定方式的限位器钳制导入数量（手动 9999 / manualGlobal 9999 / qwerty 26 / qwerFlow 12）
    const maxCount = (typeof strategy.limit === 'number') ? strategy.limit : Infinity;
    const slice = entries.slice(0, Math.min(cfg.count, maxCount));
    const records = [];
    // 固定模式：所有短语统一使用 orderValue 这一个候选位置；
    // 自动模式：以 1 为起点交给 resolveOrderConflicts 做冲突检测与递增。
    const baseOrder = cfg.orderMode === 'fixed'
      ? Math.max(1, (cfg.orderValue | 0) || 1)
      : 1;
    slice.forEach((entry, i) => {
      const locked = cfg.lockedBindings?.[i];
      const code = (locked != null && String(locked) !== '')
        ? locked
        : (locked != null ? '' : strategy.generate(entry, i));
      const word = entry.getField(cfg.phraseField) || entry.kanji || entry.raw;
      records.push({ code, word, order: baseOrder });
      for (const alias of (aliases[i] || [])) {
        records.push({ code: alias, word, order: baseOrder });
      }
    });
    return records;
  }

  /**
   * 构建记录并（若 orderMode='auto'）解析候选位置冲突。
   * 候选位置为「固定」时也检测现有词条中 (code, order) 冲突，
   * 返回 adjustments 让 UI 提示用户「即将覆盖」并确认。
   * @returns {Promise<{records: Array, adjustments: Array|null}>}
   *   adjustments 仅在 auto/fixed 模式有冲突时有值；
   *   - auto：每项 {code, word, fromOrder, toOrder}（自动避让结果）
   *   - fixed：每项 {code, word, fromOrder}（即将覆盖的现有词条）
   */
  async buildRecordsWithResolution(entries, config, aliases = {}) {
    const cfg = config instanceof ImportConfig ? config : new ImportConfig(config);
    const records = this.buildRecords(entries, cfg, aliases);

    // 自动模式：读取现有词条，检测 (code, candidate) 冲突
    const existing = await this.mschxudpExporter.parseExisting(this.importer.eudpPath);

    if (cfg.orderMode === 'auto') {
      const result = MschxudpExporter.resolveOrderConflicts(records, existing);
      return result;
    }

    // 固定模式：检测即将覆盖现有词条的 (code, order) 冲突，仅报告不修改
    if (cfg.orderMode === 'fixed') {
      const order = Math.max(1, cfg.orderValue | 0 || 1);
      const occupied = new Map(); // key: "code\0order" -> {code, word, order}
      for (const e of existing) {
        occupied.set(`${e.code}\u0000${e.candidate}`, { code: e.code, word: e.word, candidate: e.candidate });
      }
      const adjustments = [];
      const seen = new Set();
      for (const r of records) {
        const code = r.code || '';
        const k = `${code}\u0000${order}`;
        if (seen.has(k)) continue;
        const hit = occupied.get(k);
        if (hit && !seen.has(k)) {
          // 即将覆盖现有词条
          adjustments.push({ code, word: hit.word, fromOrder: order });
          seen.add(k);
        }
      }
      return { records, adjustments: adjustments.length ? adjustments : null };
    }

    // 其他模式（理论上不应出现）
    return { records, adjustments: null };
  }

  async exportBuffer(entries, config, aliases, filePath) {
    const { records } = await this.buildRecordsWithResolution(entries, config, aliases);
    // UDL 格式（异步，需要读已有文件合并）
    const udlBuffer = await this.udlExporter.export(records, { filePath });
    // machxudp 格式（同步，旧版自定义短语位置）
    const machxudpBuffer = this.machxudpExporter.export(records);
    // mschxudp 格式（合并现有条目，Settings UI 真正读写的 EUDPv1.lex）
    //    ⚠️ 同 addPhrase：当现有文件为空（count=0）时改用 merge=false 重建，
    //    避免 Settings UI 在 clear→import 序列下产生「编辑：失败」。
    let mergeEudp = true;
    try {
      const existing = await this.mschxudpExporter.parseExisting(this.importer.eudpPath);
      if (existing.length === 0) mergeEudp = false;
    } catch { mergeEudp = false; }
    const mschxudpBuffer = await this.mschxudpExporter.export(records, { filePath: this.importer.eudpPath, merge: mergeEudp });
    return { records, udlBuffer, machxudpBuffer, mschxudpBuffer };
  }

  /**
   * 导入：生成三格式 Buffer → 分别写入三个文件路径 → IME 重载
   */
  async import(entries, config, { aliases, filePath } = {}) {
    const { records, udlBuffer, machxudpBuffer, mschxudpBuffer } =
      await this.exportBuffer(entries, config, aliases, filePath);

    const result = await this.importer.import({ udlBuffer, machxudpBuffer, mschxudpBuffer, filePath });

    return {
      ...result,
      buffer: mschxudpBuffer,
      records,
    };
  }

  async clear() {
    return this.importer.clear();
  }

  async undo(payload) {
    return this.importer.undo(payload);
  }

  /**
   * 导入单条自定义短语（code → word），三层字典文件各自合并现有词条后写回并触发 IME 重载。
   * @param {{code:string, word:string, order?:number}} opts
   * @returns {Promise<object>} 导入结果（含 added 记录与 reload 信息）
   */
  async addPhrase({ code, word, order = 1 } = {}) {
    const rec = {
      code: String(code ?? '').normalize('NFC'),
      word: String(word ?? '').normalize('NFC'),
      order: (order & 0xff) || 1,
    };
    if (!rec.code || !rec.word) throw new Error('code 和 word 均不能为空');

    // 1. 主目标：EUDPv1.lex（mschxudp）— merge 保留现有
    //    ⚠️ 修复：clear() 写空文件后，merge=true 仍走「读现有 + 加新」路径，
    //    Settings UI 偶发 "编辑：失败"。当现有文件解析为空（count=0）时改为
    //    merge=false 完全重建，避免与 _buildEmpty* 写入的空文件元数据冲突。
    let mergeEudp = true;
    try {
      const existing = await this.mschxudpExporter.parseExisting(this.importer.eudpPath);
      if (existing.length === 0) mergeEudp = false;
    } catch { /* 读不到视为不存在，仍走 merge=false 重建 */ mergeEudp = false; }
    const mschx = await this.mschxudpExporter.export([rec], { filePath: this.importer.eudpPath, merge: mergeEudp });
    // 2. 兜底：UDL.dat — 按 word 合并现有
    const udl = await this.udlExporter.exportMerge([rec], this.importer.targetPath);
    // 3. 兜底：CustomPhrases/ChsUserPhrase.dat（machxudp）— 解析现有后追加（自身去重）
    const existingMach = await this.machxudpExporter.parse(this.importer.legacyPath);
    const seen = new Set(existingMach.map((e) => `${e.code}\u0000${e.word}`));
    if (!seen.has(`${rec.code}\u0000${rec.word}`)) {
      existingMach.push({ code: rec.code, word: rec.word, candidate: rec.order });
    }
    const mach = this.machxudpExporter.export(
      existingMach.map((e) => ({ code: e.code, word: e.word, order: e.candidate }))
    );

    const result = await this.importer.import({ udlBuffer: udl, machxudpBuffer: mach, mschxudpBuffer: mschx });
    return { ...result, added: rec };
  }

  /**
   * 删除单条自定义短语（按 code + word 精确匹配），三层字典文件各自解析→过滤→重建→写回并重载。
   * @param {{code:string, word:string}} opts
   * @returns {Promise<object>} 导入结果（含 removed 记录与 reload 信息）
   */
  async deletePhrase({ code, word } = {}) {
    const code0 = String(code ?? '').normalize('NFC');
    const word0 = String(word ?? '').normalize('NFC');
    if (!code0 || !word0) throw new Error('code 和 word 均不能为空');
    const match = (e) => !(e.code === code0 && e.word === word0);

    // 1. 主目标：EUDPv1.lex — 解析现有 → 过滤 → 重建（merge:false）
    const existingEudp = await this.mschxudpExporter.parseExisting(this.importer.eudpPath);
    const filteredEudp = existingEudp
      .filter(match)
      .map((e) => ({ code: e.code, word: e.word, order: e.candidate }));
    const mschx = await this.mschxudpExporter.export(filteredEudp, { filePath: this.importer.eudpPath, merge: false });

    // 2. 兜底：UDL.dat — 解析现有（含 code）→ 过滤 → 由原始 60 字节重建（merge:false）
    const existingUdl = await this.udlExporter.parseEntriesWithCode(this.importer.targetPath);
    const filteredUdl = existingUdl.filter(match).map((e) => e.raw);
    const udl = this.udlExporter.buildFromRaws(filteredUdl);

    // 3. 兜底：CustomPhrases/ChsUserPhrase.dat（machxudp）— 解析 → 过滤 → 重建
    const existingMach = await this.machxudpExporter.parse(this.importer.legacyPath);
    const filteredMach = existingMach
      .filter(match)
      .map((e) => ({ code: e.code, word: e.word, order: e.candidate }));
    const mach = this.machxudpExporter.export(filteredMach);

    const result = await this.importer.import({ udlBuffer: udl, machxudpBuffer: mach, mschxudpBuffer: mschx });
    return { ...result, removed: { code: code0, word: word0 } };
  }
}
