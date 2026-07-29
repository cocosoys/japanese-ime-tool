import assert from 'assert';
import { createBindingStrategy, BINDING_LIMITS } from '../src/implementations/binding/BindingStrategyFactory.js';
import { NameEntry } from '../src/entities/NameEntry.js';

const entries = [
  new NameEntry({ kanji: '雪', romaji: 'yuki', hiragana: 'ゆき', cnSimplified: '雪' }),
  new NameEntry({ kanji: '桜', romaji: 'sakura', hiragana: 'さくら', cnSimplified: '樱' }),
  new NameEntry({ kanji: '春樹', romaji: 'haruki', hiragana: 'はるき', cnSimplified: '春树' }),
];

// manual（锁定优先）
const manual = createBindingStrategy('manual', { locked: { 1: 'custom' } });
assert.strictEqual(manual.generate(entries[1], 1), 'custom');
assert.strictEqual(manual.generate(entries[0], 0), ''); // 未锁定留空
assert.strictEqual(manual.limit, 9999);
console.log('✓ manual 绑定（含锁定，limit=9999）');

// qwerty（英文键位顺序，24 位）
const qwerty = createBindingStrategy('qwerty');
assert.strictEqual(qwerty.generate(entries[0], 0), 'q');
assert.strictEqual(qwerty.generate(entries[0], 9), 'p');  // 第 10 位 = p
assert.strictEqual(qwerty.generate(entries[0], 23), 'b'); // 第 24 位 = b
assert.strictEqual(qwerty.generate(entries[0], 24), '');  // 越界 → 空
assert.strictEqual(qwerty.limit, 24);
console.log('✓ qwerty 绑定（24 位，越界返回空）');

// qwerFlow（英文键位流转顺序，12 位）
const qwerFlow = createBindingStrategy('qwerFlow');
assert.strictEqual(qwerFlow.generate(entries[0], 0), 'q');
assert.strictEqual(qwerFlow.generate(entries[0], 5), 's');  // 第 6 位 = s
assert.strictEqual(qwerFlow.generate(entries[0], 11), 'v'); // 第 12 位 = v
assert.strictEqual(qwerFlow.generate(entries[0], 12), '');  // 越界 → 空
assert.strictEqual(qwerFlow.limit, 12);
console.log('✓ qwerFlow 绑定（12 位，越界返回空）');

// 未知类型回退 manual
const fallback = createBindingStrategy('romaji');
assert.strictEqual(fallback.name, 'manual');
console.log('✓ 未知类型回退 manual');

// 限位器映射
assert.deepStrictEqual(BINDING_LIMITS, { manual: 9999, manualGlobal: 9999, qwerty: 24, qwerFlow: 12 });
console.log('✓ BINDING_LIMITS = { manual: 9999, manualGlobal: 9999, qwerty: 24, qwerFlow: 12 }');

// manualGlobal（复用手动策略）
const mg = createBindingStrategy('manualGlobal');
assert.strictEqual(mg.name, 'manual');
assert.strictEqual(mg.limit, 9999);
console.log('✓ manualGlobal 绑定（复用 manual，limit=9999）');

console.log('\n绑定策略测试全部通过 ✅');
