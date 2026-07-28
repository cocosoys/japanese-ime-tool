// 实体层：导入配置（悬浮窗里用户可调的部分）
export class ImportConfig {
  constructor({
    count = 10,
    phraseField = 'kanji',
    bindingStrategy = 'romaji',
    lockedBindings = {},
    orderValue = 1,
    orderMode = 'fixed',
  } = {}) {
    this.count = count;                 // 一键导入数量
    this.phraseField = phraseField;     // 用作「短语」的字段：kanji/romaji/hiragana/cnSimplified
    this.bindingStrategy = bindingStrategy; // romaji/sequential/chineseApprox/manual
    this.lockedBindings = lockedBindings;   // { [index]: 自定义编码 } —— 锁定绑定
    this.orderValue = orderValue;       // 候选窗口位置（固定模式下所有短语统一使用此值）
    this.orderMode = orderMode;         // 候选位置模式: 'fixed'(固定=orderValue) | 'auto'(冲突检测)
  }

  toJSON() {
    return {
      count: this.count,
      phraseField: this.phraseField,
      bindingStrategy: this.bindingStrategy,
      lockedBindings: this.lockedBindings,
      orderValue: this.orderValue,
      orderMode: this.orderMode,
    };
  }
}
