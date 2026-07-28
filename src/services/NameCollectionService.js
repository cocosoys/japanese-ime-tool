import { NamechefSource } from '../implementations/source/NamechefSource.js';
import { NamechefHtmlParser } from '../implementations/parser/NamechefHtmlParser.js';
import { TempJsonStore } from '../store/tempJsonStore.js';
import { NameEntry } from '../entities/NameEntry.js';

// 服务层（API 上层）：抓取 -> 解析 -> 存临时 JSON。UI 只调这一层。
export class NameCollectionService {
  constructor({ source, parser, store } = {}) {
    this.source = source || new NamechefSource();
    this.parser = parser || new NamechefHtmlParser();
    this.store = store || new TempJsonStore();
  }

  async collect({ cookie, url, gender = 'G', popularity = 'popular', save = true } = {}) {
    const html = await this.source.fetchNames({ cookie, url, gender, popularity });
    // 每次抓取生成新的时间戳目录
    if (save) {
      this.store.resetDir();
      await this.store.saveHtml(html);
    }
    const items = this.parser.parse(html);
    const entries = items.map((i) => new NameEntry(i));
    if (save) await this.store.saveNamesJson(entries.map((e) => e.toJSON()));
    return entries;
  }

  async loadCached() {
    const data = await this.store.loadNamesJson();
    return (data || []).map((d) => new NameEntry(d));
  }
}
