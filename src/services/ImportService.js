import { createBindingStrategy } from '../implementations/binding/BindingStrategyFactory.js';
import { MsPinyinDatExporter } from '../implementations/exporter/MsPinyinDatExporter.js';
import { MsPinyinImporter } from '../implementations/importer/MsPinyinImporter.js';
import { ImportConfig } from '../entities/ImportConfig.js';

// 服务层（API 上层）：装配绑定 -> 导出 .dat -> 写入 IME。UI 只调这一层。
export class ImportService {
  constructor({ exporter, importer } = {}) {
    this.exporter = exporter || new MsPinyinDatExporter();
    this.importer = importer || new MsPinyinImporter();
  }

  // 把 NameEntry[] 按配置生成 {code, word, order} 记录。
  // aliases: { [index]: [codeA, codeB] } —— 同一词条追加的别名绑定（额外记录）。
  buildRecords(entries, config, aliases = {}) {
    const cfg = config instanceof ImportConfig ? config : new ImportConfig(config);
    const strategy = createBindingStrategy(cfg.bindingStrategy, { locked: cfg.lockedBindings });
    const slice = entries.slice(0, cfg.count);
    const records = [];
    let order = cfg.orderStart;
    slice.forEach((entry, i) => {
      const locked = cfg.lockedBindings?.[i];
      // 锁定且显式为空 => 保留空编码；否则用锁定值；否则策略生成
      const code = (locked != null && String(locked) !== '')
        ? locked
        : (locked != null ? '' : strategy.generate(entry, i));
      const word = entry.getField(cfg.phraseField) || entry.kanji || entry.raw;
      records.push({ code, word, order: order++ });
      // 别名绑定：同词追加额外编码
      for (const alias of (aliases[i] || [])) {
        records.push({ code: alias, word, order: order++ });
      }
    });
    return records;
  }

  exportBuffer(entries, config, aliases) {
    const records = this.buildRecords(entries, config, aliases);
    return { records, buffer: this.exporter.export(records) };
  }

  async import(entries, config, { aliases, filePath } = {}) {
    const { buffer, records } = this.exportBuffer(entries, config, aliases);
    const target = await this.importer.import(buffer, { filePath });
    return { target, buffer, records };
  }
}
