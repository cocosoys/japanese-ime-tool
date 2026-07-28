import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 中文近似音绑定：优先用简体中文译名，否则退化为罗马音。
// 说明：完整「日文->拼音」需要字典，这里用已抽取的 cnSimplified 字段近似。
export class ChineseApproxBinding extends BindingStrategy {
  get name() { return 'chineseApprox'; }
  generate(entry, index) {
    const code = (entry.cnSimplified || entry.romaji || '').trim();
    return code || `name${index + 1}`;
  }
}
