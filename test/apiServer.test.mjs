// API 服务路由与响应形状测试（使用 mock 服务，不触碰真实 IME / 网络）
import { createApiServer } from '../src/api/server.js';
import { strict as assert } from 'assert';

let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

async function call(base, path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

const mockCtx = {
  collection: {
    store: {
      listBatches: async () => ['2026-01-01_0000'],
      loadBatch: async () => ({ entries: [{ kanji: '田中', romaji: 'tanaka', hiragana: 'たなか' }], used: ['tanaka'] }),
      resetDir() {}, saveHtml() {}, saveNamesJson() {},
    },
    parser: { parse: () => [{ kanji: '田中', romaji: 'tanaka', hiragana: 'たなか' }] },
    collect: async () => [{ toJSON: () => ({ kanji: '田中', romaji: 'tanaka', hiragana: 'たなか' }) }],
  },
  importer: {
    import: async () => ({ target: 't', reloaded: { killedChsIME: true }, backupPath: 'bp', records: [{ code: 'q', word: '田中' }] }),
    clear: async () => ({ originalCount: 0 }),
    addPhrase: async (o) => ({ added: o }),
    deletePhrase: async (o) => ({ removed: o }),
    undo: async () => ({}),
  },
  bindingsStore: { load: async () => ({}) },
  notify: () => {},
  runAutoCf: null,
};

const api = createApiServer(mockCtx);
const info = await api.start(0);
const base = info.url;

try {
  // 自描述端点
  let r = await call(base, '/api');
  assert.strictEqual(r.json.ok, true);
  assert.ok(Array.isArray(r.json.data.endpoints) && r.json.data.endpoints.length >= 8);
  ok('GET /api 返回端点列表');

  // 健康检查
  r = await call(base, '/api/health');
  assert.strictEqual(r.json.ok, true);
  ok('GET /api/health');

  // 短语字段字典
  r = await call(base, '/api/fields');
  assert.strictEqual(r.json.data.fields.length, 3);
  assert.ok(r.json.data.fields.some((f) => f.value === 'kanji'));
  ok('GET /api/fields 返回 3 个字段');

  // 批次列表
  r = await call(base, '/api/batches');
  assert.ok(r.json.data.batches.includes('2026-01-01_0000'));
  ok('GET /api/batches 返回批次');

  // 批次使用情况（romaji 字段下 tanaka 已用）
  r = await call(base, '/api/batches/usage?field=romaji');
  const u = r.json.data.usage.find((x) => x.batch === '2026-01-01_0000');
  assert.strictEqual(u.used, 1);
  assert.strictEqual(u.total, 1);
  ok('GET /api/batches/usage 统计正确');

  // 批次导入列表
  r = await call(base, '/api/batch/2026-01-01_0000/entries?field=kanji');
  assert.strictEqual(r.json.data.entries[0].field, '田中');
  ok('GET /api/batch/:batch/entries 返回条目');

  // 抓取
  r = await call(base, '/api/fetch', 'POST', { gender: 'G', popularity: 'popular' });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.count, 1);
  ok('POST /api/fetch 触发抓取');

  // 导入
  r = await call(base, '/api/import', 'POST', { batch: '2026-01-01_0000', count: 1, binding: 'manual' });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.count, 1);
  ok('POST /api/import 触发导入');

  // 清除
  r = await call(base, '/api/clear', 'POST');
  assert.strictEqual(r.json.ok, true);
  ok('POST /api/clear 触发清除');

  // 单条导入
  r = await call(base, '/api/phrase', 'POST', { code: 'q', word: '田中' });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.added.code, 'q');
  ok('POST /api/phrase 导入单条');

  // 单条删除（POST）
  r = await call(base, '/api/phrase/delete', 'POST', { code: 'q', word: '田中' });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.removed.code, 'q');
  ok('POST /api/phrase/delete 删除单条');

  // 单条删除（DELETE）
  r = await call(base, '/api/phrase', 'DELETE', { code: 'q', word: '田中' });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.removed.word, '田中');
  ok('DELETE /api/phrase 删除单条');

  // 撤回
  r = await call(base, '/api/undo', 'POST', {});
  assert.strictEqual(r.json.ok, true);
  ok('POST /api/undo 撤回');

  // 未知路由 404
  r = await call(base, '/api/nope');
  assert.strictEqual(r.status, 404);
  ok('未知路由返回 404');

  // 非法 JSON 请求体 400
  const bad = await fetch(base + '/api/phrase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.strictEqual(bad.status, 400);
  ok('非法 JSON 请求体返回 400');

  // API 文档静态资源（text/html，仅 API 启用时可访问）
  const doc = await fetch(base + '/api-docs.html');
  assert.strictEqual(doc.status, 200);
  assert.ok((doc.headers.get('content-type') || '').includes('text/html'));
  const docText = await doc.text();
  assert.ok(docText.includes('Local HTTP API') || docText.includes('japanese-ime-tool'));
  ok('GET /api-docs.html 返回 API 文档 HTML');

  await api.stop();
  console.log(`API 服务测试全部通过 ✅ (${passed} 项)`);
} catch (e) {
  await api.stop().catch(() => {});
  console.error('API 服务测试失败 ❌:', e.message);
  process.exit(1);
}
