import { app, BrowserWindow, ipcMain, clipboard, nativeTheme, shell, Tray, Menu } from 'electron';
import path from 'path';
import { promises as fsp, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { NameCollectionService } from './src/services/NameCollectionService.js';
import { ImportService } from './src/services/ImportService.js';
import { NameEntry } from './src/entities/NameEntry.js';
import { ImportConfig } from './src/entities/ImportConfig.js';
import { ConfigStore } from './src/store/configStore.js';
import { BindingsStore } from './src/store/bindingsStore.js';
import { ShortcutsStore } from './src/store/shortcutsStore.js';
import { Logger } from './src/store/logger.js';
import { detectConfigIssues, isolateIssues } from './src/store/configIntegrity.js';
import { BUILTIN_CODES, BUILTIN_LANGS } from './src/store/builtinLang.js';
import { getLangDir, ensureLangFiles, sanitizeLangCode, LOCALE_RE, isValidLangFile } from './src/store/langPaths.js';
import { BINDING_LIMITS } from './src/implementations/binding/BindingStrategyFactory.js';
import { createApiServer } from './src/api/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const collection = new NameCollectionService();
const importer = new ImportService();
const configStore = new ConfigStore();
const bindingsStore = new BindingsStore();
const shortcutsStore = new ShortcutsStore();
const logger = new Logger();

let mainWindow = null;       // 主窗口引用（用于 API 操作后通知渲染进程刷新）
let apiServer = null;        // 本地 HTTP API 服务实例
let tray = null;             // 系统托盘图标（隐藏窗口时显示）

/** 同步读取 config.yaml 中的 pinned 属性（窗口创建前需要知道置顶状态） */
function readPinnedSync() {
  try {
    const cfgPath = path.join(process.cwd(), 'data', 'config.yaml');
    const text = readFileSync(cfgPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf(':');
      if (idx < 0) continue;
      const key = t.slice(0, idx).trim();
      if (key === 'pinned') return t.slice(idx + 1).trim() === 'true';
    }
  } catch { /* 文件不存在或读取失败，回退默认 false（不强制置顶） */ }
  return false; // 默认不置顶（由 config.yaml 的 pinned 属性决定）
}

function createWindow(initialPinned = false) {
  const win = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 320,
    minHeight: 420,
    alwaysOnTop: initialPinned,   // 由 config.yaml 的 pinned 属性决定初始状态
    frame: false,             // 无边框
    transparent: true,        // 透明背景（配合 CSS 圆角卡片）
    resizable: true,
    hasShadow: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // 生产模式首次运行：把随包语言包复制到可写目录（userData/lang），作为运行期基础
  try { await ensureLangFiles(); } catch { /* 不影响启动 */ }
  createWindow(readPinnedSync());

  // 启动本地 HTTP API 服务（默认 127.0.0.1:18765，可在 config.yaml 关闭/改端口）
  try {
    const cfg = await configStore.load();
    if (cfg.apiEnabled) {
      apiServer = createApiServer({
        collection,
        importer,
        bindingsStore,
        runAutoCf,
        notify: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-refresh');
        },
      });
      const info = await apiServer.start(Number(cfg.apiPort) || 18765);
      logger.info(`本地 HTTP API 已启动：${info.url}`);
    } else {
      logger.info('本地 HTTP API 未启用（config.yaml apiEnabled=false）');
    }
  } catch (e) {
    logger.error(`本地 HTTP API 启动失败：${e.message}`);
  }
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(readPinnedSync());
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 自动过 Cloudflare ----------
// 轮询等待 cf_clearance cookie 出现（质询通过后 Cloudflare 才会下发）
async function waitForCookie(session, name, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const cs = await session.cookies.get({ name, domain: '.namechef.co' });
    if (cs.length && cs[0].value) return cs[0].value;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// 用隐藏 BrowserWindow（真实 Chromium）访问目标页，自动通过 JS 质询并取回 cf_clearance。
// 若 20 秒内未通过（可能是需手动点击的 Turnstile），把窗口弹出来让用户点一下，再等 60 秒。
// 抽取为独立函数，供 IPC（UI 抓取）与本地 HTTP API（/api/fetch 无 cookie 时）共用。
async function runAutoCf(opts = {}) {
  const target = opts.url ||
    'https://www.namechef.co/cn/name-generator/japanese/?gender=G&popularity%5B%5D=popular';

  const cfWin = new BrowserWindow({
    width: 480,
    height: 600,
    show: false,
    alwaysOnTop: true,
    title: 'Cloudflare 验证',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  cfWin.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
  );

  try {
    logger.info(`auto-cf 开始：${target}`);
    // loadURL 在质询重定向时可能抛错（ERR_ABORTED），忽略之，靠轮询 cookie 判断结果
    cfWin.loadURL(target).catch(() => {});

    // 阶段一：隐藏窗口静默等 20 秒（JS 质询一般 3~8 秒内过）
    let cookie = await waitForCookie(cfWin.webContents.session, 'cf_clearance', 20000);

    // 阶段二：仍没过 → 大概率是要人工点的 Turnstile，弹出窗口让用户交互
    if (!cookie && !cfWin.isDestroyed()) {
      logger.warn('auto-cf 静默质询超时，弹出窗口等待用户交互');
      cfWin.show();
      cookie = await waitForCookie(cfWin.webContents.session, 'cf_clearance', 60000);
    }

    if (!cookie) {
      logger.error('auto-cf 失败：Cloudflare 质询未通过（超时）');
      throw new Error('Cloudflare 质询未通过（超时）。请重试，或手动在浏览器中获取 cookie。');
    }
    logger.info('auto-cf 成功：已取得 cf_clearance cookie');

    // 质询已过，页面就是真实结果页 —— 直接把 HTML 也带回去，
    // 避免 Node fetch 因 TLS 指纹差异被 Cloudflare 二次拦截
    let html = '';
    try {
      // 等页面渲染稳定一点
      await new Promise((r) => setTimeout(r, 1500));
      html = await cfWin.webContents.executeJavaScript('document.documentElement.outerHTML', true);
      logger.info(`auto-cf 已取回页面 HTML（${html.length} 字符）`);
    } catch { logger.warn('auto-cf 取回 HTML 失败，将退回 cookie+fetch 方案'); }

    return { cookie, html };
  } finally {
    if (!cfWin.isDestroyed()) cfWin.destroy();
  }
}

ipcMain.handle('auto-cf', (_e, opts) => runAutoCf(opts));

// 直接用已拿到的 HTML 解析（跳过网络请求），复用服务层的 parser + store。
// 完整流程：保存 HTML → 解析名字 → 保存 JSON → 返回结果
ipcMain.handle('collect-from-html', async (_e, { html }) => {
  try {
    // 每次抓取生成新的时间戳目录
    collection.store.resetDir();

    // 1. 保存原始 HTML 到 data/names_data/日期/response.html
    const htmlPath = await collection.store.saveHtml(html);
    logger.info(`已保存 HTML → ${htmlPath}`);

    // 2. 解析名字
    const items = collection.parser.parse(html);
    const entries = items.map((i) => new NameEntry(i));

    // 3. 保存 JSON 到 data/names_data/日期/name.json（只存 kanji/romaji/hiragana）
    const jsonPath = await collection.store.saveNamesJson(entries.map((x) => x.toJSON()));
    logger.info(`解析出 ${entries.length} 个名字 → ${jsonPath}`);

    return {
      entries: entries.map((x) => x.toJSON()),
      htmlPath,
      jsonPath,
      batch: path.basename(path.dirname(jsonPath)),  // 批次目录名，供 UI 刷新批次选择栏
      count: entries.length,
    };
  } catch (err) {
    logger.error(`collect-from-html 失败：${err.message}`);
    throw err;
  }
});

// IPC：UI 只通过这些通道调用服务层
ipcMain.handle('collect', async (_e, opts) => {
  try {
    const entries = await collection.collect(opts);
    logger.info(`collect(fetch) 成功：${entries.length} 个名字`);
    return entries.map((e) => e.toJSON());
  } catch (err) {
    logger.error(`collect(fetch) 失败：${err.message}`);
    throw err;
  }
});
ipcMain.handle('cached', async () => {
  const entries = await collection.loadCached();
  return entries.map((e) => e.toJSON());
});
ipcMain.handle('import', async (_e, { config, entries, aliases }) => {
  try {
    const ents = (entries || []).map((d) => NameEntry.fromJSON(d));
    const result = await importer.import(ents, new ImportConfig(config), { aliases });
    logger.info(`导入成功：${result.records?.length ?? '?'} 条 → ${result.target}`);
    return result;
  } catch (err) {
    logger.error(`导入失败：${err.message}`);
    throw err;
  }
});

// 候选位置冲突检测（导入前调用，返回调整信息供用户确认）
ipcMain.handle('resolve-orders', async (_e, { config, entries, aliases }) => {
  try {
    const ents = (entries || []).map((d) => NameEntry.fromJSON(d));
    const { records, adjustments } = await importer.buildRecordsWithResolution(ents, new ImportConfig(config), aliases);
    return { records, adjustments };
  } catch (err) {
    logger.error(`resolve-orders 失败：${err.message}`);
    throw err;
  }
});

// 一键清除：清空用户自定义短语（保留备份用于撤回）
ipcMain.handle('clear-ime', async () => {
  try {
    const result = await importer.clear();
    logger.info(`清除成功：原 ${result.originalCount} 条 → ${result.target}`);
    return result;
  } catch (err) {
    logger.error(`清除失败：${err.message}`);
    throw err;
  }
});

// 撤回上一次导入/清除操作
ipcMain.handle('undo-ime', async (_e, payload) => {
  try {
    const result = await importer.undo(payload);
    logger.info(`撤回成功 → ${result.target}`);
    return result;
  } catch (err) {
    logger.error(`撤回失败：${err.message}`);
    throw err;
  }
});

// ─── 批次管理：不同日期生成的名称 + used.json 已使用记录 ───
ipcMain.handle('batches', () => collection.store.listBatches());
ipcMain.handle('batch-load', async (_e, { batch }) => {
  const data = await collection.store.loadBatch(batch);
  logger.info(`加载批次 ${batch}：${data.entries.length} 条名称，${data.used.length} 条已使用`);
  return data;
});
ipcMain.handle('used-save', async (_e, { batch, used }) => {
  const fp = await collection.store.saveUsed(batch, used || []);
  logger.info(`已使用记录更新：${batch} 共 ${(used || []).length} 条 → ${fp}`);
  return fp;
});

// 各批次使用情况（按当前短语字段统计已用/总数），供批次选择栏进度条渲染
ipcMain.handle('batches-usage', async (_e, { field } = {}) => {
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
});

// 配置读写（./data/config.yaml）
ipcMain.handle('config-load', () => configStore.load());

// 启动期配置完整性检测：扫描配置文件，返回异常清单（不崩溃，供 UI 弹框）
ipcMain.handle('config-check', () => detectConfigIssues());
// 隔离异常配置文件：重命名为 原名_error_<毫秒时间戳>，返回隔离结果
ipcMain.handle('config-isolate', async (_e, { issues } = {}) => isolateIssues(issues || []));
ipcMain.handle('config-save', async (_e, cfg) => {
  const merged = await configStore.save(cfg);
  logger.info(`配置已保存：${JSON.stringify(merged)}`);
  return merged;
});

// 各绑定方式的「导入数量限位器」最大值（手动 9999 / 手动(全局) 9999 / 英文键位顺序 24 / 流转顺序 12）
ipcMain.handle('binding-limits', () => BINDING_LIMITS);

// 手动绑定读写（./data/bindings.json，按 批次+行号 持久化，跨批次/重启保留）
ipcMain.handle('bindings-load', () => bindingsStore.load());
ipcMain.handle('bindings-save', async (_e, { batch, rows } = {}) => {
  if (!batch) return bindingsStore.load();
  const all = await bindingsStore.saveBatch(batch, rows || {});
  logger.info(`手动绑定已保存：${batch} 共 ${Object.keys(rows || {}).length} 行`);
  return all;
});
// 全局默认绑定（bindings.json 的 __global__ 键，批次未手动填写时回退套用）
ipcMain.handle('bindings-save-global', async (_e, { rows } = {}) => {
  const all = await bindingsStore.saveGlobal(rows || {});
  logger.info(`全局默认绑定已保存：共 ${Object.keys(rows || {}).length} 行`);
  return all;
});

// 快捷键配置读写（./data/shortcuts.json，含组合键与启用/禁用状态，持久化保存）
ipcMain.handle('shortcuts-load', () => shortcutsStore.load());
ipcMain.handle('shortcuts-save', async (_e, partial) => {
  const merged = await shortcutsStore.save(partial || {});
  logger.info(`快捷键配置已保存`);
  return merged;
});

// 删除数据批次：删除批次目录 + 级联删除该批次的关联绑定（bindings.json 中对应键）
ipcMain.handle('batch-delete', async (_e, { batch } = {}) => {
  if (!batch) return { ok: false, error: 'no batch' };
  try {
    await bindingsStore.saveBatch(batch, {});      // 级联：移除该批次的手动绑定
    await collection.store.deleteBatch(batch);     // 删除批次数据目录
    logger.info(`已删除批次 ${batch}（含关联绑定）`);
    return { ok: true };
  } catch (e) {
    logger.error(`删除批次失败：${e.message}`);
    return { ok: false, error: e.message };
  }
});

// ─── i18n 语言包（./data/lang/<code>.json） ───
// 可写目录由 langPaths 解析（开发 cwd/data/lang；生产 userData/lang）。
// 加载策略：文件异常时，zh-CN/en 从代码中内置表复制一份到本地并重载；其他语言不采取任何措施。
ipcMain.handle('lang-load', async (_e, { lang } = {}) => {
  // 净化并校验 locale：保留下划线（兼容 hi_IN），非法命名回退到内置默认语言
  const raw = sanitizeLangCode(lang || 'zh-CN');
  const code = LOCALE_RE.test(raw) ? raw : 'zh-CN';
  const file = path.join(getLangDir(), `${code}.json`);
  const tryRead = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));
  try {
    return await tryRead(file);
  } catch {
    if (BUILTIN_CODES.includes(code)) {
      // 内置语言：从代码复制回本地并重新加载
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(BUILTIN_LANGS[code], null, 2), 'utf8');
        logger.info(`语言包 ${code}.json 异常，已从内置表恢复到本地`);
        return BUILTIN_LANGS[code];
      } catch (e) {
        logger.error(`语言包 ${code}.json 恢复失败：${e.message}`);
      }
    }
    logger.warn(`语言包 ${code}.json 异常且非内置语言，跳过（不采取任何措施）`);
    return {};
  }
});

// 可用语言列表：扫描可写语言目录，严格按 i18n 命名格式识别，返回 [{ code, language, file }]。
// 支持用户以 i18n 命名（<code>.json，兼容 - 与 _ 分隔）自行放入的其他语言；
// 非 i18n 命名的 .json（如 notes.json）被忽略；异常的非内置语言不列出。
ipcMain.handle('lang-list', async () => {
  const langDir = getLangDir();
  let files = [];
  try { files = await fsp.readdir(langDir); } catch { files = []; }
  const langs = [];
  for (const f of files) {
    if (!isValidLangFile(f)) continue; // 仅接受 i18n 命名，过滤无关 .json
    const code = f.slice(0, -5);
    const file = path.join(langDir, f);
    try {
      const json = JSON.parse(await fsp.readFile(file, 'utf8'));
      langs.push({ code, language: json.language || code, file: f });
    } catch {
      // 异常文件：内置语言复制到本地后列入；其他语言跳过（不采取任何措施）
      if (BUILTIN_CODES.includes(code)) {
        try {
          await fsp.mkdir(langDir, { recursive: true });
          await fsp.writeFile(file, JSON.stringify(BUILTIN_LANGS[code], null, 2), 'utf8');
          logger.info(`语言包 ${code}.json 异常，已从内置表恢复到本地（列表）`);
          langs.push({ code, language: BUILTIN_LANGS[code].language || code, file: f });
        } catch { /* 忽略 */ }
      }
    }
  }
  return langs;
});

// 系统主题查询（供「跟随系统」模式使用）
ipcMain.handle('system-theme', () => ({ dark: nativeTheme.shouldUseDarkColors }));

// 固定到窗口最前面（切换 alwaysOnTop，返回新状态）
// opts.pinned 为布尔时直接设定该状态；省略则切换当前状态
ipcMain.handle('toggle-always-on-top', (e, opts = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return { pinned: true };
  const next = (typeof opts.pinned === 'boolean') ? opts.pinned : !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  logger.info(`置顶状态：${next ? '已固定' : '已取消固定'}`);
  return { pinned: next };
});

// 复制文本到系统剪贴板（供名称点击复制使用）
ipcMain.handle('copy-text', (_e, { text } = {}) => {
  if (text != null) clipboard.writeText(String(text));
  return true;
});

// 本地 HTTP API 状态查询（供设置面板展示端口与启用情况）
ipcMain.handle('api-status', () => {
  const port = apiServer ? (apiServer.server.address()?.port) : null;
  return { enabled: !!apiServer, url: apiServer ? apiServer.address() : null, port };
});

// 本地 HTTP API 启停切换（点击设置面板「已启用/已停止」文字触发）
ipcMain.handle('api-toggle', async () => {
  try {
    let enabled;
    let startedUrl = null;
    let startedPort = null;
    if (apiServer) {
      // 停止服务
      await apiServer.stop();
      apiServer = null;
      enabled = false;
    } else {
      // 启动服务
      const cfg = await configStore.load();
      apiServer = createApiServer({
        collection,
        importer,
        bindingsStore,
        runAutoCf,
        notify: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-refresh');
        },
      });
      const info = await apiServer.start(Number(cfg.apiPort) || 18765);
      enabled = true;
      startedUrl = info.url;
      startedPort = info.port;
    }
    // 持久化 apiEnabled 到 config.yaml（下次启动据此自动恢复启停状态）
    await configStore.save({ apiEnabled: enabled });
    return enabled
      ? { enabled: true, url: startedUrl, port: startedPort }
      : { enabled: false };
  } catch (e) {
    return { enabled: !!apiServer, error: e.message };
  }
});

// 用系统默认程序打开外部地址（如本地 API 文档 http://127.0.0.1:18765/api-docs.html）
ipcMain.handle('open-external', (_e, { path } = {}) => {
  if (!path) return false;
  shell.openExternal(String(path));
  return true;
});

ipcMain.on('close', () => BrowserWindow.getFocusedWindow()?.close());

/**
 * 获取或创建系统托盘图标。
 * 托盘图标用于「隐藏图标」功能：窗口隐藏后用户可通过托盘恢复。
 */
function getOrCreateTray() {
  if (tray) return tray;
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('Japanese Names · IME Phrases');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  // 单击托盘图标也恢复窗口
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  return tray;
}

/** 「隐藏图标」：隐藏主窗口 + 显示系统托盘（可从托盘恢复） */
ipcMain.on('minimize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  getOrCreateTray();
  win.hide();
});
