import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 英文键位流转顺序绑定：qwerasdfzxcv（共 12 位）
// 第 i 个名字的编码 = 该序列的第 i 个字符；超过 12 位则无编码（受限位器约束）。
const QWER_FLOW = 'qwerasdfzxcv';

export class QwerFlowBinding extends BindingStrategy {
  get name() { return 'qwerFlow'; }
  get limit() { return QWER_FLOW.length; }
  generate(entry, index) { return QWER_FLOW[index] || ''; }
}
