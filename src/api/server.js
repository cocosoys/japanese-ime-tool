import http from 'http';
import path from 'path';
import { promises as fsp } from 'fs';
import { URL, fileURLToPath } from 'url';
import { dirname } from 'path';
import { NameEntry } from '../entities/NameEntry.js';
import { BINDING_LIMITS } from '../implementations/binding/BindingStrategyFactory.js';

/**
 * 当前模块目录（ESM 下需自行计算 __dirname）。
 * server.js 位于 <root>/src/api/，故 root = __dirname/../..
 * @type {string}
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @module src/api/server
 * @description 本地 HTTP API 服务模块。提供 RESTful 风格的网络接口，
 *   供本地脚本 / 外部程序以 HTTP 方式调用工具各项功能（抓取、导入、清除、批次管理等）。
 *   仅绑定 127.0.0.1（本机回环），不对外暴露。
 *
 * @example
 * import { createApiServer } from './src/api/server.js';
 * const server = createApiServer({ collection, importer, bindingsStore, runAutoCf, notify });
 * await server.start(18765); // 监听 http://127.0.0.1:18765
 * console.log(server.address()); // "http://127.0.0.1:18765"
 * await server.stop();
 */

/**
 * 短语字段字典：定义可用的名称维度及其多语言标签。
 * @constant {Array<{value: string, label: string}>}
 */
const FIELDS = [
  { value: 'kanji', label: '汉字' },
  { value: 'romaji', label: '罗马音' },
  { value: 'hiragana', label: '平假名' },
];

/**
 * API 文档 HTML 文件绝对路径（项目根 docs/ 目录）。
 * 仅当本地 HTTP API 启用时，才作为静态资源对外暴露，地址为 {apiUrl}/api-docs.html。
 * @type {string}
 */
const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'api-docs.html');

/**
 * 创建并返回一个本地 HTTP API 服务实例。
 *
 * @param {Object} ctx - 服务依赖上下文
 * @param {import('../services/NameCollectionService.js').NameCollectionService} ctx.collection - 名称集合服务（批次管理、抓取、解析）
 * @param {import('../services/ImportService.js').ImportService} ctx.importer - 导入服务（写入 IME 字典）
 * @param {import('../store/bindingsStore.js').BindingsStore} ctx.bindingsStore - 绑定持久化存储
 * @param {Function} [ctx.runAutoCf] - Cloudflare 质询通过函数（可选，无 cookie 时自动调用）
 * @param {Function} [ctx.notify] - 操作完成后通知渲染进程刷新的回调（API 操作后触发 UI 刷新）
 * @returns {{server: http.Server, start: function(port): Promise<{port:number,host:string,url:string}>, stop: function(): Promise<void>, address: function(): string|null}}
 *
 * @example
 * const api = createApiServer({
 *   collection,
 *   importer,
 *   bindingsStore,
 *   runAutoCf: async (opts) => ({ cookie, html }),
 *   notify: () => mainWindow?.webContents.send('api-refresh'),
 * });
 * const info = await api.start(18765);
 * // info => { port: 18765, host: '127.0.0.1', url: 'http://127.0.0.1:18765' }
 */
export function createApiServer(ctx) {
  const { collection, importer, bindingsStore, notify } = ctx;
  const runAutoCf = ctx.runAutoCf || null;

  /**
   * 解析 HTTP 请求体为 JSON 对象。
   * 限制请求体大小为 5MB，防止内存溢出攻击。
   *
   * @param {http.IncomingMessage} req - HTTP 请求对象
   * @returns {Promise<Object>} 解析后的 JSON 对象（空请求体返回 {}）
   * @throws {Error} 请求体超过 5MB 或非法 JSON
   *
   * @private
   */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) { req.destroy(); reject(new Error('请求体过大（>5MB）')); return; }
        data += c;
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
      });
      req.on('error', reject);
    });
  }

  /**
   * 发送 JSON 响应。
   * 统一设置 CORS 头，支持跨域调用（仅限本机场景）。
   *
   * @param {http.ServerResponse} res - HTTP 响应对象
   * @param {number} status - HTTP 状态码
   * @param {Object} obj - 响应数据（自动序列化为 JSON）
   * @private
   */
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(body);
  }

  /** @param {http.ServerResponse} res @param {*} data 发送成功响应 {ok:true,data} */
  const ok = (res, data) => sendJson(res, 200, { ok: true, data });
  /** @param {http.ServerResponse} res @param {number} status @param {*} error 发送失败响应 {ok:false,error} */
  const fail = (res, status, error) => sendJson(res, status, { ok: false, error: String((error && error.message) || error) });

  /**
   * 通知渲染进程刷新界面（API 写操作后调用）。
   * 通过主进程 webContents.send('api-refresh') 触发 renderer 的 refreshAll()。
   * @private
   */
  const notifyRefresh = () => { try { notify && notify(); } catch { /* 忽略通知失败 */ } };

  // ════════════ 路由处理器 ════════════

  /**
   * 执行抓取操作：从 namechef.co 获取日文名并存入新批次。
   *
   * 支持三种模式：
   * 1. **直接 HTML** — body.html 已包含完整页面（跳过网络请求）
   * 2. **Cookie + fetch** — body.cookie 为已获取的 cf_clearance cookie
   * 3. **全自动** — 无 cookie 时自动调用 runAutoCf（弹出隐藏窗口过 Cloudflare 质询）
   *
   * @param {Object} body - 请求体
   * @param {string} [body.gender] - 性别筛选：G(女名) / B(男名) / U(中性)，默认 G
   * @param {string} [body.popularity] - 名字风格：popular / unique / trending，默认 popular
   * @param {string} [body.cookie] - cf_clearance cookie 值（已有时跳过自动质询）
   * @param {string} [body.html] - 完整页面 HTML（优先级最高，直接解析）
   * @param {string} [body.url] - 目标 URL（runAutoCf 使用，默认 namechef 日文名生成器）
   * @returns {Promise<{count:number, batch:string|null, entries:Array}>} 抓取结果
   * @throws {Error} Cloudflare 质询超时或网络错误
   *
   * @example
   * // POST /api/fetch
   * // Request: { gender: "G", popularity: "popular" }
   * // Response: { ok: true, data: { count: 21, batch: "2026-07-29_1025", entries: [...] } }
   */
  async function doFetch(body) {
    const gender = body.gender || 'G';
    const popularity = body.popularity || 'popular';
    if (body.html && body.html.length > 500) {
      collection.store.resetDir();
      await collection.store.saveHtml(body.html);
      const items = collection.parser.parse(body.html);
      const entries = items.map((i) => new NameEntry(i));
      await collection.store.saveNamesJson(entries.map((e) => e.toJSON()));
    } else {
      const cookie = body.cookie;
      if (!cookie && runAutoCf) {
        const cf = await runAutoCf({ url: body.url });
        if (cf.html && cf.html.length > 500) {
          collection.store.resetDir();
          await collection.store.saveHtml(cf.html);
          const items = collection.parser.parse(cf.html);
          const entries = items.map((i) => new NameEntry(i));
          await collection.store.saveNamesJson(entries.map((e) => e.toJSON()));
        } else {
          await collection.collect({ cookie: cf.cookie, gender, popularity });
        }
      } else {
        await collection.collect({ cookie, gender, popularity });
      }
    }
    const batch = (await collection.store.listBatches())[0] || null;
    const data = batch ? await collection.store.loadBatch(batch) : { entries: [] };
    const entries = (data.entries || []).map((e) => new NameEntry(e));
    return { count: entries.length, batch, entries: entries.map((e) => e.toJSON()) };
  }

  /**
   * 执行一键导入操作：将指定批次的名称按绑定方式写入 IME 自定义短语。
   *
   * 从 bindingsStore 加载已持久化的手动绑定映射到 lockedBindings，
   * 支持的绑定策略：manual / manualGlobal / qwerty / qwerFlow。
   *
   * @param {Object} body - 请求体
   * @param {string} [body.batch] - 目标批次名（默认最新批次）
   * @param {number} [body.count=10] - 导入数量（受 BINDING_LIMITS 钳制）
   * @param {string} [body.binding='manual'] - 绑定策略
   * @param {string} [body.orderMode='fixed'] - 候选位置模式：fixed / auto
   * @param {number} [body.orderPos=1] - 固定模式的候选位置值
   * @param {string} [body.phraseField='kanji'] - 短语字段：kanji / romaji / hiragana
   * @param {Object} [body.aliases={}] - 别名映射（行号 → 编码数组）
   * @returns {Promise<Object>} 导入结果（含 records 数量、目标路径、重载状态等）
   * @throws {Error} 无可用批次或批次无数据
   *
   * @example
   * // POST /api/import
   * // Request: { batch: "2026-07-29_1025", count: 10, binding: "qwerty" }
   * // Response: { ok: true, data: { count: 10, batch: "2026-07-29_1025", target: "...", reloaded: {...} } }
   */
  async function doImport(body) {
    const batches = await collection.store.listBatches();
    const batch = body.batch || batches[0];
    if (!batch) throw new Error('没有可用的数据批次');
    const data = await collection.store.loadBatch(batch);
    const entries = (data.entries || []).map((d) => NameEntry.fromJSON(d));
    if (!entries.length) throw new Error('批次无数据');

    let count = Math.max(1, parseInt(body.count, 10) || 10);
    const binding = body.binding || 'manual';
    const limit = BINDING_LIMITS[binding] ?? Infinity;
    if (count > limit) count = limit;
    const orderMode = body.orderMode || 'fixed';
    const orderValue = Math.max(1, parseInt(body.orderPos, 10) || 1);
    const phraseField = body.phraseField || 'kanji';

    // 从持久化绑定（bindings.json）映射 lockedBindings（API 无渲染进程内存态）
    const all = await bindingsStore.load();
    const lockedBindings = {};
    const aliases = body.aliases || {};
    const isManualGlobal = binding === 'manualGlobal';
    entries.slice(0, count).forEach((_e, i) => {
      let b = null;
      if (isManualGlobal) b = (all.__global__ && all.__global__[i]) || null;
      else if (binding === 'manual') b = (all[batch] && all[batch][i]) || null;
      if (b && b.identifier) lockedBindings[i] = b.identifier;
    });

    const config = { count, phraseField, bindingStrategy: binding, lockedBindings, orderMode, orderValue };
    const result = await importer.import(entries, config, { aliases });
    return {
      count: result.records?.length,
      batch,
      target: result.target,
      reloaded: result.reloaded,
      backupPath: result.backupPath,
    };
  }

  /**
   * 计算各批次的使用情况统计（按指定字段维度）。
   *
   * @param {string} field - 统计维度：kanji / romaji / hiragana
   * @returns {Promise<Array<{batch:string, used:number, total:number}>>} 各批次使用情况列表
   * @private
   */
  async function batchesUsage(field) {
    const batches = await collection.store.listBatches();
    const out = [];
    for (const b of batches) {
      try {
        const data = await collection.store.loadBatch(b);
        const usedSet = new Set(data.used || []);
        let used = 0;
        for (const e of data.entries || []) {
          const val = (e && (e[field] || e.kanji || e.raw)) || '';
          if (val && usedSet.has(val)) used++;
        }
        out.push({ batch: b, used, total: (data.entries || []).length });
      } catch {
        out.push({ batch: b, used: 0, total: 0 });
      }
    }
    return out;
  }

  /**
   * 获取指定批次的条目列表。
   *
   * @param {string} batch - 批次目录名
   * @param {string} [field='kanji'] - 返回条目中作为主字段的键
   * @param {number|null} [count=null] - 返回条目数量限制（null=全部）
   * @returns {Promise<Array<{kanji:string, romaji:string, hiragana:string, field:string}>>} 条目列表
   * @private
   */
  async function batchEntries(batch, field, count) {
    const data = await collection.store.loadBatch(batch);
    let entries = data.entries || [];
    if (count) entries = entries.slice(0, count);
    return entries.map((e) => ({
      kanji: e.kanji, romaji: e.romaji, hiragana: e.hiragana,
      field: (field && e[field]) || e.kanji,
    }));
  }

  // ════════════ 路由表 ════════════
  const ROUTES = [];
  /**
   * 注册路由规则。
   * @param {string} method - HTTP 方法：GET / POST / DELETE
   * @param {string|RegExp} pattern - 路径匹配（精确字符串或正则表达式）
   * @param {Function} handler - 路由处理函数 (match, query, body) => data
   * @private
   */
  const add = (method, pattern, handler) => ROUTES.push({ method, pattern, handler });

  /**
   * GET /api — API 根端点，返回服务信息与可用端点列表。
   * @route GET /api
   * @returns {Promise<{service:string, note:string, endpoints:string[]}>}
   */
  add('GET', '/api', async () => ({
    service: 'japanese-ime-tool',
    note: '仅监听 127.0.0.1（本机）。请求体为 JSON，响应统一 { ok, data|error }。',
    endpoints: [
      'GET  /api/health',
      'GET  /api/fields',
      'GET  /api/batches',
      'GET  /api/batches/usage?field=kanji',
      'GET  /api/batch/:batch/entries?field=kanji&count=10',
      'POST /api/fetch                { gender?, popularity?, cookie?, html?, url? }',
      'POST /api/import               { batch?, count?, binding?, orderMode?, orderPos?, phraseField?, aliases? }',
      'POST /api/clear',
      'POST /api/phrase               { code, word, order? }',
      'POST /api/phrase/delete        { code, word }',
      'DELETE /api/phrase             { code, word }',
      'POST /api/undo                 { backups? }',
      'GET  /api-docs.html            (静态资源) API 文档 HTML，地址 = {apiUrl}/api-docs.html',
    ],
  }));

  /**
   * GET /api/health — 健康检查端点。
   * @route GET /api/health
   * @returns {Promise<{ok:boolean, uptime:number}>} uptime 为进程运行秒数
   */
  add('GET', '/api/health', async () => ({ ok: true, uptime: process.uptime() }));

  /**
   * GET /api/fields — 获取可用短语字段列表（字典）。
   * @route GET /api/fields
   * @returns {Promise<{fields:Array<{value:string,label:string}>}>} 字段值与标签映射
   */
  add('GET', '/api/fields', async () => ({ fields: FIELDS }));

  /**
   * GET /api/batches — 获取所有数据批次目录名列表。
   * @route GET /api/batches
   * @returns {Promise<{batches:string[]}>} 批次名数组（按时间倒序）
   */
  add('GET', '/api/batches', async () => ({ batches: await collection.store.listBatches() }));

  /**
   * GET /api/batches/usage — 获取各批次使用情况（已用/总数进度）。
   * @route GET /api/batches/usage
   * @query {string} [field=kanji] - 统计维度
   * @returns {Promise<{usage:Array<{batch:string,used:number,total:number}>}>}
   */
  add('GET', '/api/batches/usage', async (_, q) => ({ usage: await batchesUsage(q.get('field') || 'kanji') }));

  /**
   * GET /api/batch/:batch/entries — 获取指定批次的条目列表。
   * @route GET /api/batch/:batch/entries
   * @param {string} batch - 批次目录名（URL 路径参数）
   * @query {string} [field=kanji] - 主字段
   * @query {number} [count] - 返回数量限制
   * @returns {Promise<{batch:string,field:string,entries:Array}>}
   */
  add('GET', /^\/api\/batch\/([^/]+)\/entries$/, async (m, q) => ({
    batch: m[1],
    field: q.get('field') || 'kanji',
    entries: await batchEntries(m[1], q.get('field') || 'kanji', q.get('count') ? parseInt(q.get('count'), 10) : null),
  }));

  /**
   * POST /api/fetch — 抓取日文名并存入新批次（见 doFetch 文档）。
   * @route POST /api/fetch
   * @see doFetch
   */
  add('POST', '/api/fetch', async (_, _q, body) => { const r = await doFetch(body); notifyRefresh(); return r; });

  /**
   * POST /api/import — 一键导入（见 doImport 文档）。
   * @route POST /api/import
   * @see doImport
   */
  add('POST', '/api/import', async (_, _q, body) => { const r = await doImport(body); notifyRefresh(); return r; });

  /**
   * POST /api/clear — 清空所有 IME 自定义短语。
   * @route POST /api/clear
   * @returns {Promise<Object>} 清除结果（含 originalCount、target、reloaded 等）
   */
  add('POST', '/api/clear', async () => { const r = await importer.clear(); notifyRefresh(); return r; });

  /**
   * POST /api/phrase — 导入单条自定义短语到 IME 字典（三层写入）。
   * @route POST /api/phrase
   * @param {string} code - 触发码（拼音编码，如 "sakura"）
   * @param {string} word - 短语文本（如 "桜"）
   * @param {number} [order=1] - 候选位置
   * @returns {Promise<Object>} 添加结果（含 added、目标路径等）
   */
  add('POST', '/api/phrase', async (_, _q, body) => { const r = await importer.addPhrase(body); notifyRefresh(); return r; });

  /**
   * POST /api/phrase/delete — 删除单条自定义短语（三层删除）。
   * @route POST /api/phrase/delete
   * @param {string} code - 触发码
   * @param {string} word - 短语文本
   * @returns {Promise<Object>} 删除结果
   */
  add('POST', '/api/phrase/delete', async (_, _q, body) => { const r = await importer.deletePhrase(body); notifyRefresh(); return r; });

  /**
   * DELETE /api/phrase — 删除单条自定义短语（DELETE 方法版本）。
   * @route DELETE /api/phrase
   * @param {string} code - 触发码
   * @param {string} word - 短语文本
   * @returns {Promise<Object>} 删除结果
   */
  add('DELETE', '/api/phrase', async (_, _q, body) => { const r = await importer.deletePhrase(body); notifyRefresh(); return r; });

  /**
   * POST /api/undo — 撤回上一次导入或清除操作。
   * @route POST /api/undo
   * @param {Object} [body={}] - 撤回参数（通常含 backups 信息）
   * @returns {Promise<Object>} 撤回结果
   */
  add('POST', '/api/undo', async (_, _q, body) => importer.undo(body || {}));

  /**
   * 匹配请求方法与路径到注册的路由。
   * @param {string} method - HTTP 方法
   * @param {string} pathname - 请求路径
   * @returns {{route:Object, match:RegExpMatchArray|null}|null}
   * @private
   */
  function matchRoute(method, pathname) {
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      if (r.pattern instanceof RegExp) {
        const m = pathname.match(r.pattern);
        if (m) return { route: r, match: m };
      } else if (r.pattern === pathname) {
        return { route: r, match: null };
      }
    }
    return null;
  }

  /**
   * HTTP 服务器实例（原生 Node.js http.createServer）。
   * 处理所有传入请求：CORS 预检 → 路由匹配 → 请求体解析 → handler 调用 → JSON 响应。
   * 未匹配路由返回 404；handler 异常返回 400。
   * @type {http.Server}
   */
  const server = http.createServer(async (req, res) => {
    // 预检
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }

    // 静态资源：API 文档 HTML（仅本地 API 启用时可通过 {apiUrl}/api-docs.html 访问）
    // 以 text/html 直接返回，便于在浏览器中渲染查看（不作为 JSON 响应）
    if (req.method === 'GET' && req.url.split('?')[0] === '/api-docs.html') {
      try {
        const html = await fsp.readFile(DOC_PATH, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(html);
      } catch (e) {
        fail(res, 404, `API 文档未找到：${e.message}`);
      }
      return;
    }

    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    const matched = matchRoute(req.method, pathname);
    if (!matched) { fail(res, 404, `未知接口：${req.method} ${pathname}`); return; }
    try {
      let body = {};
      if (req.method === 'POST' || req.method === 'DELETE') body = await readBody(req);
      const data = await matched.route.handler(matched.match, u.searchParams, body);
      ok(res, data);
    } catch (e) {
      fail(res, 400, e);
    }
  });

  return {
    server,
    /**
     * 在指定端口启动 HTTP 服务（host 固定 127.0.0.1）。
     * port 传 0 时由系统分配随机端口（用于测试避免冲突），返回真实端口号。
     *
     * @param {number} [port=18765] - 监听端口
     * @returns {Promise<{port:number, host:string, url:string}>} 启动后的地址信息
     *
     * @example
     * const info = await server.start();  // 默认 18765
     * // info => { port: 18765, host: '127.0.0.1', url: 'http://127.0.0.1:18765' }
     *
     * const info = await server.start(0);  // 系统分配端口
     * // info => { port: 53821, host: '127.0.0.1', url: 'http://127.0.0.1:53821' }
     */
    start(port = 18765) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const addr = server.address();
          resolve({ port: addr.port, host: '127.0.0.1', url: `http://127.0.0.1:${addr.port}` });
        });
      });
    },
    /**
     * 停止 HTTP 服务（关闭底层 socket）。
     * @returns {Promise<void>}
     */
    stop() { return new Promise((resolve) => server.close(() => resolve())); },
    /**
     * 获取当前监听地址字符串（未启动返回 null）。
     * @returns {string|null} 如 "http://127.0.0.1:18765"
     */
    address() { const a = server.address(); return a ? `http://127.0.0.1:${a.port}` : null; },
  };
}
