import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 英文键位顺序绑定：qwertyuiopasdfghjklzxcvb（共 24 位）
// 第 i 个名字的编码 = 该序列的第 i 个字符；超过序列长度则无编码（受限位器约束）。
// 注：需求描述为 36 位，但所给出的序列实际为 24 位；此处以真实长度为准，避免编码越界。
const QWERTY = 'qwertyuiopasdfghjklzxcvb';

export class QwertyBinding extends BindingStrategy {
  get name() { return 'qwerty'; }
  get limit() { return QWERTY.length; }
  generate(entry, index) { return QWERTY[index] || ''; }
}
