import { promises as fs } from 'fs';
import path from 'path';

/**
 * 手动绑定存储 → ./data/bindings.json
 *
 * 结构（嵌套）：
 * {
 *   "__global__": {                                  ← 全局默认绑定（批次未手动填写时回退套用）
 *     "<行号>": { "identifier": "拼音编码", "locked": true }
 *   },
 *   "<批次目录名>": {
 *     "<该名字在批次中的原始行号>": { "identifier": "拼音编码", "locked": true },
 *     ...
 *   }
 * }
 *
 * 以「批次 + 原始行号」为稳定键，使手动绑定在排序重排、切换批次、重启程序后
 * 都能正确对应到原来的名字，且各批次互不干扰。
 * 批次级绑定优先；某行在当前批次没有记录时，回退使用 __global__ 中同行号的绑定。
 * （批次目录名形如 2026-07-31_114932_1785469772230，不会与 "__global__" 冲突。）
 */
const DEFAULT_PATH = path.join(process.cwd(), 'data', 'bindings.json');
const GLOBAL_KEY = '__global__';

export class BindingsStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || DEFAULT_PATH;
  }

  /** 读取全部绑定（缺失/损坏时返回 {}） */
  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const obj = JSON.parse(text);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  /**
   * 保存某个批次的行绑定。
   * @param {string} batch - 批次目录名
   * @param {Object} rows - { [row]: { identifier, locked } }；为空对象时删除该批次
   */
  async saveBatch(batch, rows) {
    const all = await this.load();
    if (rows && Object.keys(rows).length) all[batch] = rows;
    else delete all[batch];
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(all, null, 2), 'utf8');
    return all;
  }

  /**
   * 保存全局默认绑定（存于 "__global__" 键下）。
   * @param {Object} rows - { [row]: { identifier, locked } }；为空对象时删除全局配置
   */
  async saveGlobal(rows) {
    return this.saveBatch(GLOBAL_KEY, rows);
  }
}

export { DEFAULT_PATH as BINDINGS_DEFAULT_PATH, GLOBAL_KEY as BINDINGS_GLOBAL_KEY };
