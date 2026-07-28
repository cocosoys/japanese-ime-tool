import { NameParser } from '../../interfaces/NameParser.js';
import { load } from 'cheerio';

/**
 * namechef 日文名字产生器 HTML 解析器。
 *
 * 真实 DOM 结构（服务端渲染）：
 *   <div id="name_zh_0">东宪子</div>          ← 简体/日文原名（有时混假名）
 *   <div id="name_jp_0">のりこ あずま</div>    ← 平假名读法
 *   <div id="name_en_0">Noriko Azuma</div>     ← 罗马音
 *
 * 每组三个 div 包在一个 .col-12.col-lg-6 > .bg-white.rounded 容器里，
 * 按数字下标 _0, _1, _2 ... 顺序排列。
 */
export class NamechefHtmlParser extends NameParser {
  constructor(opts = {}) {
    super();
    // 可覆盖的选择器，默认匹配真实 namechef 结构
    this.zhSelector = opts.zhSelector || 'div[id^="name_zh_"]';
    this.jpSelector = opts.jpSelector || 'div[id^="name_jp_"]';
    this.enSelector = opts.enSelector || 'div[id^="name_en_"]';
  }

  parse(html) {
    const $ = load(html);
    const $zh = $(this.zhSelector);
    const $jp = $(this.jpSelector);
    const $en = $(this.enSelector);

    const items = [];
    const len = Math.min($zh.length, $jp.length, $en.length);

    for (let i = 0; i < len; i++) {
      const cnSimplified = $zh.eq(i).text().trim();
      const hiragana = $jp.eq(i).text().trim();
      const romaji = $en.eq(i).text().trim();

      // kanji 字段：优先从 cnSimplified 中提取纯汉字部分；
      // 如果 cnSimplified 本身就是纯汉字则直接用，否则保留原样
      const kanji = cnSimplified;

      if (kanji || hiragana || romaji) {
        items.push({ kanji, romaji, hiragana, cnSimplified, raw: kanji });
      }
    }

    return items;
  }
}
