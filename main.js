import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { NameCollectionService } from './src/services/NameCollectionService.js';
import { ImportService } from './src/services/ImportService.js';
import { NameEntry } from './src/entities/NameEntry.js';
import { ImportConfig } from './src/entities/ImportConfig.js';
import { ConfigStore } from './src/store/configStore.js';
import { Logger } from './src/store/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const collection = new NameCollectionService();
const importer = new ImportService();
const configStore = new ConfigStore();
const logger = new Logger();

function createWindow() {
  const win = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 320,
    minHeight: 420,
    alwaysOnTop: true,        // 悬浮置顶
    frame: false,             // 无边框
    transparent: true,        // 透明背景（配合 CSS 圆角卡片）
    resizable: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
ipcMain.handle('auto-cf', async (_e, opts = {}) => {
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
});

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

// 配置读写（./data/config.yaml）
ipcMain.handle('config-load', () => configStore.load());
ipcMain.handle('config-save', async (_e, cfg) => {
  const merged = await configStore.save(cfg);
  logger.info(`配置已保存：${JSON.stringify(merged)}`);
  return merged;
});

// 固定到窗口最前面（切换 alwaysOnTop，返回新状态）
ipcMain.handle('toggle-always-on-top', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return { pinned: true };
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  logger.info(`置顶状态切换为：${next ? '已固定' : '已取消固定'}`);
  return { pinned: next };
});

// 复制文本到系统剪贴板（供名称点击复制使用）
ipcMain.handle('copy-text', (_e, { text } = {}) => {
  if (text != null) clipboard.writeText(String(text));
  return true;
});

ipcMain.on('close', () => BrowserWindow.getFocusedWindow()?.close());
ipcMain.on('minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
