import assert from 'assert';
import { createBindingStrategy } from '../src/implementations/binding/BindingStrategyFactory.js';
import { NameEntry } from '../src/entities/NameEntry.js';

const entries = [
  new NameEntry({ kanji: '雪', romaji: 'yuki', hiragana: 'ゆき', cnSimplified: '雪' }),
  new NameEntry({ kanji: '桜', romaji: 'sakura', hiragana: 'さくら', cnSimplified: '樱' }),
  new NameEntry({ kanji: '春樹', romaji: 'haruki', hiragana: 'はるき', cnSimplified: '春树' }),
];

// romaji
const romaji = createBindingStrategy('romaji');
assert.deepStrictEqual(
  entries.map((e, i) => romaji.generate(e, i)),
  ['yuki', 'sakura', 'haruki']
);
console.log('✓ romaji 绑定');

// sequential
const seq = createBindingStrategy('sequential', { prefix: 'jp' });
assert.deepStrictEqual(
  entries.map((e, i) => seq.generate(e, i)),
  ['jp1', 'jp2', 'jp3']
);
console.log('✓ sequential 绑定');

// chineseApprox
const cn = createBindingStrategy('chineseApprox');
assert.deepStrictEqual(
  entries.map((e, i) => cn.generate(e, i)),
  ['雪', '樱', '春树']
);
console.log('✓ chineseApprox 绑定');

// manual（锁定优先）
const manual = createBindingStrategy('manual', { locked: { 1: 'custom' } });
assert.strictEqual(manual.generate(entries[1], 1), 'custom');
assert.strictEqual(manual.generate(entries[0], 0), ''); // 未锁定留空
console.log('✓ manual 绑定（含锁定）');

console.log('\n绑定策略测试全部通过 ✅');
