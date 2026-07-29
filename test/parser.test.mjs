/* TEST_DEBUG_DISABLED
===== 测试/调试脚本 · 已整体注释禁用（如需恢复请删除首尾注释包裹）=====

import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { NamechefHtmlParser } from '../src/implementations/parser/NamechefHtmlParser.js';
import { ImportService } from '../src/services/ImportService.js';
import { NameEntry } from '../src/entities/NameEntry.js';
import { parseDatCheck } from './_parseDat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, 'fixtures', 'sample.html'), 'utf8');

const items = new NamechefHtmlParser().parse(html);
assert.strictEqual(items.length, 4, '解析条数不符');
assert.strictEqual(items[0].kanji, '雪');
assert.strictEqual(items[0].romaji, 'yuki');
console.log('✓ HTML 解析得到', items.length, '条');

const entries = items.map((i) => new NameEntry(i));
const svc = new ImportService();
const { records, buffer } = svc.exportBuffer(entries, {
  count: entries.length, phraseField: 'kanji', bindingStrategy: 'qwerty',
});
assert.strictEqual(records[0].code, 'q');
assert.strictEqual(records[0].word, '雪');
parseDatCheck(buffer, records);
console.log('✓ 解析 -> 绑定 -> 导出 .dat 全链路通过');

console.log('\n解析测试通过 ✅', JSON.stringify(records, null, 2));


===== 测试/调试脚本结束 ===== */
