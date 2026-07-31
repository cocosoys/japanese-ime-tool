import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 英文键位顺序绑定：qwertyuiopasdfghjklzxcvbnm（共 26 位）
// 第 i 个名字的编码 = 该序列的第 i 个字符；超过序列长度则无编码（受限位器约束）。
const QWERTY = 'qwertyuiopasdfghjklzxcvbnm';

export class QwertyBinding extends BindingStrategy {
  get name() { return 'qwerty'; }
  get limit() { return QWERTY.length; }
  generate(entry, index) { return QWERTY[index] || ''; }
}
