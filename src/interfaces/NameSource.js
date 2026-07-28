// 接口层：名字来源（抓取）
export class NameSource {
  /** @returns {Promise<string>} HTML 文本 */
  async fetchNames(opts) { throw new Error('NameSource.fetchNames 未实现'); }
}
