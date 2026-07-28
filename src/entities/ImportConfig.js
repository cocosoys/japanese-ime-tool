// 实体层：导入配置（悬浮窗里用户可调的部分）
export class ImportConfig {
  constructor({
    count = 10,
    phraseField = 'kanji',
    bindingStrategy = 'romaji',
    lockedBindings = {},
    orderStart = 1,
  } = {}) {
    this.count = count;                 // 一键导入数量
    this.phraseField = phraseField;     // 用作「短语」的字段：kanji/romaji/hiragana/cnSimplified
    this.bindingStrategy = bindingStrategy; // romaji/sequential/chineseApprox/manual
    this.lockedBindings = lockedBindings;   // { [index]: 自定义编码 } —— 锁定绑定
    this.orderStart = orderStart;       // 候选排序起始值（越小越靠前）
  }

  toJSON() {
    return {
      count: this.count,
      phraseField: this.phraseField,
      bindingStrategy: this.bindingStrategy,
      lockedBindings: this.lockedBindings,
      orderStart: this.orderStart,
    };
  }
}
