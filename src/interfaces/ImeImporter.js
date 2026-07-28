// 接口层：把 .dat 写入系统并触发输入法重新加载
export class ImeImporter {
  /** @param {Buffer} datBuffer
   *  @returns {Promise<string>} 写入的文件路径 */
  async import(datBuffer, opts) { throw new Error('ImeImporter.import 未实现'); }
}
