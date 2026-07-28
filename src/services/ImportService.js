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
    const slice = entries.slice(0, cfg.count);
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
   *
   * @returns {Promise<{records: Array, adjustments: Array|null}>}
   *   adjustments 仅在 auto 模式下有值，每项 {code, word, fromOrder, toOrder}
   */
  async buildRecordsWithResolution(entries, config, aliases = {}) {
    const cfg = config instanceof ImportConfig ? config : new ImportConfig(config);
    const records = this.buildRecords(entries, cfg, aliases);

    if (cfg.orderMode !== 'auto') {
      return { records, adjustments: null };
    }

    // 自动模式：读取现有词条，检测 (code, candidate) 冲突
    const existing = await this.mschxudpExporter.parseExisting(this.importer.eudpPath);
    const result = MschxudpExporter.resolveOrderConflicts(records, existing);
    return result;
  }

  async exportBuffer(entries, config, aliases, filePath) {
    const { records } = await this.buildRecordsWithResolution(entries, config, aliases);
    // UDL 格式（异步，需要读已有文件合并）
    const udlBuffer = await this.udlExporter.export(records, { filePath });
    // machxudp 格式（同步，旧版自定义短语位置）
    const machxudpBuffer = this.machxudpExporter.export(records);
    // mschxudp 格式（合并现有条目，Settings UI 真正读写的 EUDPv1.lex）
    const mschxudpBuffer = await this.mschxudpExporter.export(records, { filePath: this.importer.eudpPath });
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
}
