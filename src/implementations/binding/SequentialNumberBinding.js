import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 顺序编号绑定：n1 / n2 ... 简单无歧义
export class SequentialNumberBinding extends BindingStrategy {
  constructor(prefix = 'n') { super(); this.prefix = prefix; }
  get name() { return 'sequential'; }
  generate(entry, index) { return `${this.prefix}${index + 1}`; }
}
