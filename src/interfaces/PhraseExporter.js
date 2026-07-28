// 接口层：导出为 IME 可识别的 .dat 二进制
export class PhraseExporter {
  /** @param {Array<{code:string, word:string, order:number}>} records
   *  @returns {Buffer} */
  export(records) { throw new Error('PhraseExporter.export 未实现'); }
}
