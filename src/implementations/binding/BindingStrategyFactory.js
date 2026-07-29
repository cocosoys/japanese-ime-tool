import { ManualBinding } from './ManualBinding.js';
import { QwertyBinding } from './QwertyBinding.js';
import { QwerFlowBinding } from './QwerFlowBinding.js';

// 工厂：根据类型字符串创建绑定策略。新增策略只需在此登记。
export function createBindingStrategy(type, opts = {}) {
  switch (type) {
    case 'manual': return new ManualBinding(opts.locked);
    case 'manualGlobal': return new ManualBinding(opts.locked);   // 复用手动策略，编码由 UI 层从全局绑定取
    case 'qwerty': return new QwertyBinding();
    case 'qwerFlow': return new QwerFlowBinding();
    default: return new ManualBinding(opts.locked);
  }
}

export const BINDING_TYPES = ['manual', 'manualGlobal', 'qwerty', 'qwerFlow'];

// 各绑定方式的「导入数量限位器」：导入数量不得超过该最大值。
// 手动：9999；手动(全局)：9999；英文键位顺序(qwerty)：24（实际序列长度）；英文键位流转顺序(qwerFlow)：12。
export const BINDING_LIMITS = { manual: 9999, manualGlobal: 9999, qwerty: 24, qwerFlow: 12 };
