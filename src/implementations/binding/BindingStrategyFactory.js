import { RomajiBinding } from './RomajiBinding.js';
import { SequentialNumberBinding } from './SequentialNumberBinding.js';
import { ChineseApproxBinding } from './ChineseApproxBinding.js';
import { ManualBinding } from './ManualBinding.js';

// 工厂：根据类型字符串创建绑定策略。新增策略只需在此登记。
export function createBindingStrategy(type, opts = {}) {
  switch (type) {
    case 'romaji': return new RomajiBinding();
    case 'sequential': return new SequentialNumberBinding(opts.prefix);
    case 'chineseApprox': return new ChineseApproxBinding();
    case 'manual': return new ManualBinding(opts.locked);
    default: return new RomajiBinding();
  }
}

export const BINDING_TYPES = ['romaji', 'sequential', 'chineseApprox', 'manual'];
