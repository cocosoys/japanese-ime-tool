// 接口层：绑定策略契约。新增绑定方式只需新增一个实现类，上层不改动。
export class BindingStrategy {
  get name() { throw new Error('BindingStrategy.name 未实现'); }
  /** @returns {string} 编码(code) */
  generate(entry, index) { throw new Error('BindingStrategy.generate 未实现'); }
}
