// 开发用 CLI：从本地 HTML 文件走完「解析 -> 绑定 -> 导出 .dat」全流程
// 用法: node src/cli/run.mjs [html路径] [绑定策略]
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NamechefHtmlParser } from '../implementations/parser/NamechefHtmlParser.js';
import { ImportService } from '../services/ImportService.js';
import { NameEntry } from '../entities/NameEntry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.argv[2] || path.join(__dirname, '..', '..', 'test', 'fixtures', 'sample.html');
const strategy = process.argv[3] || 'romaji';

const html = readFileSync(htmlPath, 'utf8');
const entries = new NamechefHtmlParser().parse(html).map((i) => new NameEntry(i));
const svc = new ImportService();
const { records, buffer } = svc.exportBuffer(entries, {
  count: entries.length, phraseField: 'kanji', bindingStrategy: strategy,
});
const outPath = path.join(__dirname, '..', '..', 'test', 'out.dat');
writeFileSync(outPath, buffer);
console.log('绑定策略:', strategy);
console.log('记录:', records);
console.log(`已写出 .dat -> ${outPath} (${buffer.length} 字节)`);
