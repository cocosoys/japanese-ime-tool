import { ImportService } from '../src/services/ImportService.js';
import { NameEntry } from '../src/entities/NameEntry.js';
import { ImportConfig } from '../src/entities/ImportConfig.js';
import { readFileSync } from 'fs';

const svc = new ImportService();
const entries = [
  new NameEntry({ kanji: '筱水由季' }),
  new NameEntry({ kanji: '佐藤樱花' }),
];
const config = new ImportConfig({
  count: 2,
  phraseField: 'kanji',
  bindingStrategy: 'manual',
  lockedBindings: { 0: 'q', 1: 'w' },
  orderValue: 1,
});

console.log('调用 ImportService.import（按钮实际代码路径）...');
const t0 = Date.now();
const res = await svc.import(entries, config, { aliases: {} });
console.log('完成，耗时', Date.now() - t0, 'ms');
console.log('写入目标:', res.target);
console.log('记录数:', res.records.length, '->', res.records.map(r => `${r.code}:${r.word}`).join(', '));

// 校验真实文件最终状态
const b = readFileSync(res.target);
console.log('最终 magic:', b.toString('hex', 0, 4));
console.log('最终 count:', b.readUInt32LE(0x0c));
console.log('最终数据区字节 = count*60 ?', (b.length - 0x2400) === b.readUInt32LE(0x0c) * 60);
console.log('\n已触发 IME 重载。请在任意输入框键入 q 后按空格，应出现「筱水由季」。');
