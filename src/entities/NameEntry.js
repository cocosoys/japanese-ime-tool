// 实体层：名字条目，保留多种文字形式，解析阶段尽量抽全。
export class NameEntry {
  constructor({ kanji = '', romaji = '', hiragana = '', cnSimplified = '', raw = '' } = {}) {
    this.kanji = kanji;
    this.romaji = romaji;
    this.hiragana = hiragana;
    this.cnSimplified = cnSimplified;
    this.raw = raw;
  }

  /** 按字段名取值：kanji | romaji | hiragana | cnSimplified | raw */
  getField(field) {
    switch (field) {
      case 'kanji': return this.kanji;
      case 'romaji': return this.romaji;
      case 'hiragana': return this.hiragana;
      case 'cnSimplified': return this.cnSimplified;
      default: return this.raw;
    }
  }

  toJSON() {
    return {
      kanji: this.kanji,
      romaji: this.romaji,
      hiragana: this.hiragana,
      cnSimplified: this.cnSimplified,
      raw: this.raw,
    };
  }

  static fromJSON(o) {
    return new NameEntry(o);
  }
}
