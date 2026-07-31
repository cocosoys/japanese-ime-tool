// 渲染进程：UI 状态与交互。所有耗时操作都走 window.api（IPC -> 主进程服务层）。
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

const GLOBAL_KEY = '__global__';   // bindings.json 中的全局默认绑定键

const state = {
  entries: [],                 // NameEntry JSON 数组（原始顺序，与 name.json 一致）
  // 手动绑定：{ __global__: {...}, [batch]: { [行号(批次内原始位置)]: { identifier, locked } } }
  // 跨批次保留（切批次不清空），持久化到 ./data/bindings.json
  batchBindings: {},
  aliases: {},                 // { [行号(批次内原始位置)]: [code,...] } —— 仅内存，切批次清空（按需求不持久化）
  batch: null,                 // 当前选中的批次目录名（如 2026-07-31_114932_1785469772230）
  used: new Set(),             // 已使用值集合（存「短语字段的值」，持久化到 used.json）
  lastImportInfo: null,        // 上一次导入信息（用于撤回）：{ usedKeysAdded: string[], backupPath?: string }
  lang: 'zh-CN',               // 界面语言
  theme: 'system',             // 主题：light / dark / system
  bindingLimits: { manual: 9999, manualGlobal: 9999, qwerty: 26, qwerFlow: 12 }, // 各绑定方式导入数量限位器（由 IPC 覆盖）
  batches: [],                 // 全部批次目录名
  batchUsage: {},              // { [batch]: { used, total } } 按当前短语字段统计的使用情况
  shortcuts: null,             // 快捷键配置：{ [action]: { combo, enabled } }（null=未加载，回退默认）
  recording: null,             // 正在录制快捷键的动作名（null=非录制态）
};

// ─── i18n 国际化（语言包位于 ./data/lang/<code>.json，由主进程读取） ───

let I18N = {};

/** 取翻译文本；{key} 形式的占位符用 params 替换；缺失时回退 key 本身 */
function t(key, params) {
  let s = (I18N && I18N[key]) || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split('{' + k + '}').join(String(v));
    }
  }
  return s;
}

/** 加载语言包并套用到整个界面 */
async function loadLang(lang) {
  try {
    I18N = (await window.api.loadLang({ lang })) || {};
    state.lang = lang;
  } catch { I18N = {}; }
  applyI18n();
  renderShortcuts();   // 语言切换后刷新快捷键标签/描述
}

/** 用 lang-list 动态填充语言下拉，选项显示各语言包的 language 属性（支持用户新增的其他语言） */
async function populateLangSelect() {
  const sel = $('#set-lang');
  let langs = [];
  try { langs = (await window.api.langList()) || []; } catch { langs = []; }
  sel.innerHTML = '';
  for (const l of langs) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.language || l.code;
    sel.appendChild(opt);
  }
  if (state.lang) sel.value = state.lang; // 选中当前语言
}

/** 把翻译套用到所有静态元素（data-i18n / data-i18n-tip / data-i18n-ph），并重绘动态区域 */
function applyI18n() {
  $$('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  $$('[data-i18n-tip]').forEach((n) => { n.dataset.tip = t(n.dataset.i18nTip); });
  $$('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  document.title = t('app.title');
  syncOrderFixedLabel(); // data-i18n 会把「固定(=1)」写回，需按当前数值重新同步
  // 动态区域重绘（列表、统计卡）
  renderList(); renderStats();
}

// ─── 主题：亮色 / 暗色 / 跟随系统 ───

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  state.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && darkMedia.matches);
  document.body.classList.toggle('theme-dark', dark);
}

// 跟随系统模式下，系统主题变化时实时切换
darkMedia.addEventListener('change', () => { if (state.theme === 'system') applyTheme('system'); });

// ─── 手动绑定（批次级 + 全局回退） ───

/**
 * 取某行当前生效的绑定记录（无则 null）。
 * 优先级：当前批次的记录 > 全局默认（__global__）。
 * 来自全局的记录带 global:true 标记，供 UI 区分显示。
 * @param {number} row 行号
 * @param {Object} [opts] 选项
 * @param {boolean} [opts.noGlobalFallback] 为 true 时不回退全局绑定（纯手动模式）
 */
function getRowBinding(row, opts) {
  const b = state.batchBindings[state.batch];
  if (b && b[row]) return b[row];
  // 手动模式不回退全局绑定（注释掉回退逻辑；仅 manualGlobal 模式使用全局绑定）
  // if (!(opts && opts.noGlobalFallback)) {
  //   const g = state.batchBindings[GLOBAL_KEY];
  //   if (g && g[row]) return { ...g[row], global: true };
  // }
  return null;
}

/** 写入/更新某行绑定（永远写到当前批次，覆盖全局回退）；既无编码又未锁定则删除该记录 */
function setRowBinding(row, patch) {
  const batch = state.batch;
  if (!batch) return;
  state.batchBindings[batch] = state.batchBindings[batch] || {};
  const cur = state.batchBindings[batch][row] || { identifier: '', locked: false };
  const next = { ...cur, ...patch };
  if (!next.identifier && !next.locked) delete state.batchBindings[batch][row];
  else state.batchBindings[batch][row] = next;
  persistBindings();
}

let bindingsTimer = null;
function persistBindings() {
  clearTimeout(bindingsTimer);
  bindingsTimer = setTimeout(() => {
    const rows = state.batchBindings[state.batch] || {};
    window.api.saveBindings({ batch: state.batch, rows }).catch(() => {});
  }, 300);
}

/** 持久化全局默认绑定（__global__） */
let globalBindingsTimer = null;
function persistGlobalBindings() {
  clearTimeout(globalBindingsTimer);
  globalBindingsTimer = setTimeout(() => {
    const rows = state.batchBindings[GLOBAL_KEY] || {};
    window.api.saveGlobalBindings({ rows }).catch(() => {});
  }, 300);
}

// ─── 统一状态输出：所有提示 → 底部状态栏（全局唯一的信息输出终端） ───

// hintRevealEnabled：启动完成前不显现隐藏按钮（满足"启动默认隐藏"）
let hintRevealEnabled = false;
function setStatusBar(msg, kind = '') {
  const sb = $('#status-bar');
  sb.textContent = msg;
  sb.className = 'status-bar' + (kind ? ' ' + kind : '');
  // 出现新提示时显现隐藏按钮；启动阶段不显现
  if (msg && hintRevealEnabled) {
    $('.status-bar-wrap').classList.remove('hidden');
    $('#btn-hide-status').classList.add('visible');
  }
}
// 兼容别名：历史代码中的 setStatus 一律输出到底部栏
const setStatus = setStatusBar;

/** 当前是否启用开发者提示模式（config.devMode）；启用后状态栏/错误提示显示完整诊断信息 */
function devModeOn() { return !!(state.config && state.config.devMode); }

/** 状态栏智能输出：dev 模式显示完整信息，否则精简；错误态强制走 devKey（保留诊断） */
function setStatusSmart(key, params, devKey, devParams, kind) {
  if ((devModeOn() && devKey) || kind === 'err') {
    setStatusBar(t(devKey || key, devParams || params || {}), kind || 'ok');
  } else {
    setStatusBar(t(key, params || {}), kind || 'ok');
  }
}

// ─── 配置持久化（./data/config.yaml） ───

function readConfigFromUi() {
  return {
    gender: $('#gender').value,
    popularity: $('#popularity').value,
    phraseField: $('#phraseField').value,
    binding: $('#binding').value,
    count: Math.max(1, parseInt($('#count').value, 10) || 10),
    orderMode: $('#orderMode').value,
    orderValue: Math.max(1, parseInt($('#orderValue').value, 10) || 1),
  };
}

function applyConfigToUi(cfg) {
  if (!cfg) return;
  if (cfg.gender) $('#gender').value = cfg.gender;
  if (cfg.popularity) $('#popularity').value = cfg.popularity;
  if (cfg.phraseField) $('#phraseField').value = cfg.phraseField;
  if (cfg.binding) { $('#binding').value = cfg.binding; syncBindingLabel(); }
  if (cfg.count) $('#count').value = cfg.count;
  if (cfg.orderMode) $('#orderMode').value = cfg.orderMode;
  if (cfg.orderValue) $('#orderValue').value = cfg.orderValue;
  if (cfg.lang) $('#set-lang').value = cfg.lang;
  if (cfg.theme) $('#set-theme').value = cfg.theme;
  // 开发者模式开关（关闭时隐藏诊断信息）
  const devCb = $('#set-devmode');
  if (devCb) devCb.checked = !!cfg.devMode;
  updateOrderValueVisibility();
}

/** 仅在「固定」模式显示候选位置数值输入框；「自动」时隐藏 */
function updateOrderValueVisibility() {
  const sel = $('#orderMode').value;
  const input = $('#orderValue');
  if (sel === 'fixed') input.classList.add('show');
  else input.classList.remove('show');
  syncOrderFixedLabel();
}

/** 「固定(=1)」选项文字随右侧数值框同步为「固定(=N)」（翻译文案中的 1 替换为当前值） */
function syncOrderFixedLabel() {
  const opt = $('#orderMode') && $('#orderMode').querySelector('option[value="fixed"]');
  if (!opt) return;
  const n = Math.max(1, parseInt($('#orderValue').value, 10) || 1);
  opt.textContent = t('order.fixed').replace('1', String(n));
}

let saveTimer = null;
function persistConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveConfig(readConfigFromUi()).catch(() => {});
  }, 300);
}

// ─── 已使用（used.json，按短语字段的值记录） ───

function currentField() { return $('#phraseField').value; }

function usedKey(e, field = currentField()) {
  return e[field] || e.kanji || e.raw || '';
}

function isEntryUsed(e) { return state.used.has(usedKey(e)); }

async function persistUsed() {
  if (!state.batch) return;
  // __all__ 模式：按条目 __batch 把 state.used 中属于该批次的 key 合并到对应 used.json
  if (state.batch === '__all__' && state.__allKeyToBatch) {
    const writes = [];
    const batchToKeys = new Map();      // batch -> Set(usedKey)
    for (const k of state.used) {
      const b = state.__allKeyToBatch.get(k);
      if (!b) continue;
      if (!batchToKeys.has(b)) batchToKeys.set(b, new Set());
      batchToKeys.get(b).add(k);
    }
    for (const [batch, keys] of batchToKeys.entries()) {
      writes.push(window.api.saveUsed({ batch, used: [...keys] }).catch(() => {}));
    }
    await Promise.all(writes);
    return;
  }
  return window.api.saveUsed({ batch: state.batch, used: [...state.used] }).catch(() => {});
}

function sortedView() {
  // 排序策略：
  //   1. 「所有数据批次」（entries 带 __batch 字段）：先按批次名升序消耗（最早批次优先），
  //      同批次内再按「未使用在前」
  //   2. 单批次模式（entries 无 __batch）：直接按「未使用在前」
  return [...state.entries].sort((a, b) => {
    const ab = a.__batch || '';
    const bb = b.__batch || '';
    if (ab !== bb) return ab < bb ? -1 : 1;   // 早批次在前（批次目录名按时间字符串升序等价于时间升序）
    return (isEntryUsed(a) ? 1 : 0) - (isEntryUsed(b) ? 1 : 0);
  });
}

// ─── 导入数量限位器（依绑定方式） ───

function currentLimit() {
  return state.bindingLimits[$('#binding').value] || 9999;
}

/** 依绑定方式设置 count 输入框的 max 并钳制当前值 */
function applyBindingLimit() {
  const limit = currentLimit();
  const input = $('#count');
  input.max = String(limit);
  let v = parseInt(input.value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > limit) v = limit;
  input.value = String(v);
}

/** 钳制 count 到 [1, limit] */
function clampCount() {
  const limit = currentLimit();
  let v = parseInt($('#count').value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > limit) v = limit;
  $('#count').value = String(v);
}

/** 数量 ±1（受限位器约束） */
function stepCount(delta) {
  const limit = currentLimit();
  let v = parseInt($('#count').value, 10) || 1;
  v = Math.min(limit, Math.max(1, v + delta));
  $('#count').value = String(v);
  persistConfig();
}

/** 数量右击：调整至最大 / 最小 */
function setCountTo(edge) {
  const limit = currentLimit();
  $('#count').value = (edge === 'max') ? String(limit) : '1';
  persistConfig();
}

// ─── 批次下拉（自定义，带每批次使用情况进度条） ───

/** 刷新当前批次使用情况并重绘批次下拉进度条（供多处操作后调用） */
async function refreshBatchUsage() {
  await loadBatchUsage();
  renderBatchList();
}

/** 按当前短语字段拉取各批次使用情况 */
async function loadBatchUsage() {
  try {
    const usage = await window.api.batchesUsage({ field: currentField() });
    state.batchUsage = {};
    for (const u of usage) state.batchUsage[u.batch] = u;
  } catch { state.batchUsage = {}; }
}

function openBatchList() { $('#batch-list').classList.remove('hidden'); }
function closeBatchList() { $('#batch-list').classList.add('hidden'); }

/** 渲染批次下拉列表项（含使用情况进度条 + 数字标注；首项特殊 = 所有数据批次） */
function renderBatchList() {
  const list = $('#batch-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.batches.length) {
    list.appendChild(el('div', 'batch-item empty', t('list.empty')));
    return;
  }
  // 首项：所有数据批次（聚合）
  {
    const item = el('div', 'batch-item batch-item-all');
    if (state.batch === '__all__') item.classList.add('active');
    const name = el('span', 'batch-name', t('batch.all'));
    item.appendChild(name);
    // 聚合使用情况：所有批次的 used 之和 / entries 之和
    let totalAll = 0, usedAll = 0;
    for (const b of state.batches) {
      const u = state.batchUsage[b] || { used: 0, total: 0 };
      totalAll += u.total; usedAll += u.used;
    }
    const unusedAll = Math.max(0, totalAll - usedAll);
    const unusedPct = totalAll > 0 ? Math.round((unusedAll / totalAll) * 100) : 100;
    const usage = el('span', 'batch-usage');
    const bar = el('span', 'batch-bar');
    const fill = el('span', 'batch-bar-fill');
    fill.style.width = unusedPct + '%';
    bar.appendChild(fill);
    usage.appendChild(bar);
    usage.appendChild(el('span', 'batch-num', `${unusedAll}/${totalAll}`));
    item.appendChild(usage);
    item.addEventListener('click', () => {
      closeBatchList();
      if (state.batch !== '__all__') loadBatch('__all__');
    });
    list.appendChild(item);
  }
  state.batches.forEach((b) => {
    const item = el('div', 'batch-item');
    if (b === state.batch) item.classList.add('active');
    const name = el('span', 'batch-name', b);
    item.appendChild(name);

    const u = state.batchUsage[b] || { used: 0, total: 0 };
    const unused = Math.max(0, u.total - u.used);
    const unusedPct = u.total > 0 ? Math.round((unused / u.total) * 100) : 100;
    const usage = el('span', 'batch-usage');
    const bar = el('span', 'batch-bar');
    const fill = el('span', 'batch-bar-fill');
    fill.style.width = unusedPct + '%';
    bar.appendChild(fill);

    const num = el('span', 'batch-num', `${unused}/${u.total}`);

    usage.appendChild(bar);
    usage.appendChild(num);
    item.appendChild(usage);

    item.addEventListener('click', () => {
      closeBatchList();
      if (b !== state.batch) {
        loadBatch(b);
        $('#batch-label').textContent = b;
        renderBatchList();
      }
    });
    // 右击列表项 → 弹出上下文菜单（删除批次）
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showBatchCtxMenu(e.clientX, e.clientY, b);
    });
    list.appendChild(item);
  });
}// ─── 绑定方式下拉（自定义，每个选项悬停显示详细信息） ───

const BINDING_OPTIONS = [
  { value: 'manual', labelKey: 'bind.manual', tipKey: 'tip.bindManualDetail' },
  { value: 'manualGlobal', labelKey: 'bind.manualGlobal', tipKey: 'tip.bindManualGlobal' },
  { value: 'qwerty', labelKey: 'bind.qwerty', tipKey: 'tip.bindQwerty' },
  { value: 'qwerFlow', labelKey: 'bind.qwerFlow', tipKey: 'tip.bindQwerFlow' },
];

function openBindingList() { $('#binding-list').classList.remove('hidden'); }
function closeBindingList() { $('#binding-list').classList.add('hidden'); }

function renderBindingList() {
  const list = $('#binding-list');
  if (!list) return;
  list.innerHTML = '';
  const current = $('#binding').value;
  BINDING_OPTIONS.forEach((opt) => {
    const item = el('div', 'binding-item');
    if (opt.value === current) item.classList.add('active');
    item.textContent = t(opt.labelKey);
    item.dataset.tip = t(opt.tipKey);
    item.dataset.value = opt.value;
    item.addEventListener('click', () => {
      $('#binding').value = opt.value;
      $('#binding-label').textContent = t(opt.labelKey);
      closeBindingList();
      applyBindingLimit();
      renderList();
      persistConfig();
    });
    // 悬停时通过 tooltip 系统显示详细信息
    item.addEventListener('mouseenter', () => {
      const tipEl = document.getElementById('tooltip');
      if (tipEl) { tipEl.textContent = t(opt.tipKey); tipEl.classList.add('show'); }
    });
    item.addEventListener('mouseleave', () => {
      const tipEl = document.getElementById('tooltip');
      if (tipEl) tipEl.classList.remove('show');
    });
    list.appendChild(item);
  });
}

/** 抓取进度弹窗（可强制停止）：显示当前轮次 / 已抓条数 / 阶段；用户可点击「停止」 */
function showFetchProgressModal() {
  return new Promise((resolve) => {
    const overlay = $('#dialog-overlay');
    const title = $('#dialog-title');
    const body = $('#dialog-body');
    const actions = $('#dialog-actions');

    title.textContent = t('fetch.progress.title');
    title.style.color = '#1864ab';
    title.style.setProperty('::before', '"⏳"');

    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'fetch-progress';
    wrap.style.minWidth = '320px';

    const phase = document.createElement('div');
    phase.className = 'fetch-progress-phase';
    phase.textContent = t('fetch.progress.phase.cf');
    wrap.appendChild(phase);

    const body_ = document.createElement('div');
    body_.className = 'fetch-progress-body';
    body_.textContent = t('fetch.progress.body', { round: 1, rounds: 50, collected: 0, target: 0 });
    wrap.appendChild(body_);

    const bar = document.createElement('div');
    bar.className = 'fetch-progress-bar';
    bar.style.cssText = 'margin-top:10px;height:6px;background:#e9ecef;border-radius:3px;overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#74c0fc,#339af0);transition:width .25s;';
    bar.appendChild(fill);
    wrap.appendChild(bar);

    body.appendChild(wrap);

    // 暴露给进度事件回调更新
    showFetchProgressModal._update = (p) => {
      if (!p) return;
      phase.textContent = t('fetch.progress.phase.' + (p.phase || 'idle'));
      body_.textContent = t('fetch.progress.body', { round: p.round, rounds: p.rounds, collected: p.collected, target: p.target });
      const pct = p.target > 0 ? Math.min(100, Math.round((p.collected / p.target) * 100)) : 0;
      fill.style.width = pct + '%';
    };

    // 「停止」按钮 → 取消抓取并返回 false
    actions.innerHTML = '';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'dialog-btn-cancel';
    stopBtn.textContent = t('fetch.progress.stop');
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true; stopBtn.textContent = '…';
      try { await window.api.collectCancel(); } catch {}
    });
    actions.appendChild(stopBtn);

    overlay.classList.remove('hidden');
    // 用户点击遮罩 = 同义停止
    overlay.onclick = (e) => {
      if (e.target === overlay) window.api.collectCancel().catch(() => {});
    };
    // resolve 由 collectMultiple 调用方在返回时调用
    showFetchProgressModal._resolve = resolve;
  });
}

function closeFetchProgressModal() {
  const overlay = $('#dialog-overlay');
  if (overlay) overlay.classList.add('hidden');
  showFetchProgressModal._update = null;
  showFetchProgressModal._resolve = null;
}

// 监听主进程 push 的抓取进度事件（实时更新弹窗）
if (window.api && window.api.onCollectProgress) {
  window.api.onCollectProgress((p) => {
    if (typeof showFetchProgressModal._update === 'function') {
      showFetchProgressModal._update(p);
    }
  });
}

/** 多轮抓取：循环调用 collect-multiple 直到累计条数达标或被取消；弹窗显示进度，可停止 */
async function fetchMultipleWithProgress(targetCount, opts = {}) {
  showFetchProgressModal();
  try {
    const res = await window.api.collectMultiple({ targetCount, ...opts });
    return res;
  } finally {
    closeFetchProgressModal();
  }
}

/** 同步 binding-label 显示文字（供 i18n 切换时调用） */
function syncBindingLabel() {
  const val = $('#binding').value;
  const opt = BINDING_OPTIONS.find((o) => o.value === val);
  if (opt) $('#binding-label').textContent = t(opt.labelKey);
}// ─── 自定义确认弹窗（支持多按钮，返回 Promise） ───

/**
 * 显示自定义对话框。
 * @param {{ title: string, body: string, buttons: Array<{label:string,cls:string,value:any}> }} opts
 * @returns {Promise<any>} 用户点击的按钮的 value
 */
function showDialog(opts) {
  return new Promise((resolve) => {
    const overlay = $('#dialog-overlay');
    const title = $('#dialog-title');
    const body = $('#dialog-body');
    const actions = $('#dialog-actions');
    title.textContent = opts.title || '';
    body.textContent = opts.body || '';
    actions.innerHTML = '';
    (opts.buttons || []).forEach((btn) => {
      const b = document.createElement('button');
      b.className = (btn.cls || '') + ' dialog-btn';
      b.textContent = btn.label;
      b.addEventListener('click', () => {
        overlay.classList.add('hidden');
        resolve(btn.value);
      });
      actions.appendChild(b);
    });
    overlay.classList.remove('hidden');
    // 点击遮罩关闭（视为取消）
    overlay.onclick = (e) => {
      if (e.target === overlay) { overlay.classList.add('hidden'); resolve('cancel'); }
    };
  });
}/**
 * 通用列表对话框：标题 + 顶部说明 + 可滚动列表 + 「不再提醒」勾选 + 确认/取消。
 * 替代浏览器原生 confirm()，UI 风格与导入预览一致。
 * @param {object} opts
 * @param {string} opts.titleKey 标题 i18n key
 * @param {string} [opts.bodyKey] 顶部说明 i18n key（多行字符串，可带 {placeholders}）
 * @param {object} [opts.bodyParams] 顶部说明插值
 * @param {Array} opts.items 列表项
 * @param {Function} opts.itemRenderer (it, i) => { code?, word?, order?, arrow?, hint? }
 * @param {string} opts.confirmKey 确认按钮 i18n key
 * @param {string} opts.cancelKey 取消按钮 i18n key
 * @param {string} [opts.skipKey] 「不再提醒」勾选 i18n key（缺省时不显示勾选）
 * @param {string} [opts.iconColor='#1864ab'] 标题颜色
 * @returns {Promise<{confirmed:boolean, skip:boolean}>}
 */
function showListDialog(opts) {
  return new Promise((resolve) => {
    const overlay = $('#dialog-overlay');
    const title = $('#dialog-title');
    const body = $('#dialog-body');
    const actions = $('#dialog-actions');

    title.textContent = t(opts.titleKey);
    title.style.color = opts.iconColor || '#1864ab';
    title.style.setProperty('::before', '"📋"');

    body.innerHTML = '';
    if (opts.bodyKey) {
      const head = document.createElement('div');
      head.className = 'preview-header';
      const bodyText = t(opts.bodyKey, opts.bodyParams || {});
      bodyText.split('\n').forEach((line, i, arr) => {
        const div = document.createElement('div');
        div.textContent = line;
        head.appendChild(div);
      });
      body.appendChild(head);
    }

    // 列表
    const listEl = document.createElement('div');
    listEl.className = 'preview-list';
    (opts.items || []).forEach((it, i) => {
      const r = opts.itemRenderer(it, i);
      const row = document.createElement('div');
      row.className = 'preview-item' + (r._isPlaceholder ? ' preview-placeholder' : '');
      const codeSpan = el('span', 'preview-code', r.code || '—');
      row.appendChild(codeSpan);
      if (r.order) {
        const idxSpan = el('span', 'preview-idx', r.order);
        row.appendChild(idxSpan);
      }
      if (r.arrow) {
        const arrow = el('span', 'preview-arrow', r.arrow);
        row.appendChild(arrow);
      }
      if (r.word) {
        const wordSpan = el('span', 'preview-word', r.word);
        row.appendChild(wordSpan);
      }
      if (r.hint) {
        const hintSpan = el('span', 'preview-hint', r.hint);
        row.appendChild(hintSpan);
      }
      listEl.appendChild(row);
    });
    body.appendChild(listEl);

    // 「不再提醒」勾选
    actions.innerHTML = '';
    let skipCb = null;
    if (opts.skipKey) {
      // 复选框 + label 用独立元素实现（方便像「记住我的选择」一样微调样式）
      const skipWrap = document.createElement('div');
      skipWrap.className = 'preview-skip-wrap';
      skipCb = document.createElement('input');
      skipCb.type = 'checkbox';
      skipCb.id = 'preview-skip-cb-' + Math.random().toString(36).slice(2, 8);  // 避免与其他对话框冲突
      skipCb.className = 'preview-skip-cb';
      const skipLabel = document.createElement('label');
      skipLabel.className = 'preview-skip-label';
      skipLabel.setAttribute('for', skipCb.id);
      skipLabel.textContent = t(opts.skipKey);
      skipWrap.appendChild(skipCb);
      skipWrap.appendChild(skipLabel);
      actions.appendChild(skipWrap);
    }

    const btnOk = document.createElement('button');
    btnOk.className = 'dialog-btn-primary';
    btnOk.textContent = t(opts.confirmKey);
    btnOk.addEventListener('click', () => { overlay.classList.add('hidden'); resolve({ confirmed: true, skip: skipCb ? skipCb.checked : false }); });
    const btnCancel = document.createElement('button');
    btnCancel.className = 'dialog-btn-cancel';
    btnCancel.textContent = t(opts.cancelKey);
    btnCancel.addEventListener('click', () => { overlay.classList.add('hidden'); resolve({ confirmed: false, skip: skipCb ? skipCb.checked : false }); });
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);

    overlay.classList.remove('hidden');
    overlay.onclick = (e) => {
      if (e.target === overlay) { overlay.classList.add('hidden'); resolve({ confirmed: false, skip: skipCb ? skipCb.checked : false }); }
    };
  });
}

/**
 * 显示导入预览弹窗（滚动列表，每条显示编码→候选位置→短语映射）。
 * @param {Array<{code:string, word:string, order:number}>} items 预览条目
 * @returns {Promise<{confirmed:boolean, skip:boolean}>} confirmed=确认导入, skip=不再提醒
 */
function showImportPreview(items) {
  return showListDialog({
    titleKey: 'dialog.importPreview.title',
    items,
    itemRenderer: (it) => ({ code: it.code || '—', order: `第${it.order}位`, arrow: '→', word: it.word || '?' }),
    confirmKey: 'dialog.importPreview.confirm',
    cancelKey: 'dialog.importPreview.cancel',
    skipKey: 'dialog.importPreview.skip',
  });
}



/**
 * 计算某个字段维度的已用 / 未用数量。
 */
function calcFieldStats(field) {
  let total = 0, used = 0;
  for (const e of state.entries) {
    const val = (field === 'kanji') ? (e.kanji || e.raw || '')
      : (field === 'romaji') ? (e.romaji || '')
      : (e.hiragana || '');
    if (!val) continue;
    total++;
    if (state.used.has(val)) used++;
  }
  return { total, used, unused: total - used };
}

/**
 * 渲染三张仪表卡（汉字 / 罗马音 / 平假名）。
 * 每张卡片显示：大数字 = 未使用数 | 百分比 | 进度条 | 底部明细
 * 无数据批次时显示占位符「—」
 */
function renderStats() {
  const fields = ['kanji', 'romaji', 'hiragana'];
  // 无批次选中 / 无任何批次 / 无数据 → 全部显示占位符
  const isEmpty = !state.batch || !state.batches.length || (!state.entries || state.entries.length === 0);
  for (const field of fields) {
    const card = $(`.stat-card[data-field="${field}"]`);
    if (!card) continue;
    // 高亮当前短语字段对应的仪表卡（点击卡片可切换短语字段）
    card.classList.toggle('active', field === currentField());
    const valueEl = card.querySelector('.stat-card-value');
    const pctEl = card.querySelector('.stat-card-pct');
    const barFill = card.querySelector('.stat-card-bar-fill');
    const footerEl = card.querySelector('.stat-card-footer');

    if (isEmpty) {
      valueEl.textContent = '—';
      pctEl.textContent = '—%';
      valueEl.style.color = '#868e96';
      pctEl.style.color = '#868e96';
      barFill.className = 'stat-card-bar-fill level-mid';
      barFill.style.width = '0%';
      footerEl.textContent = t('stat.empty', { unused: '—', used: '—', total: '—' });
      continue;
    }

    const { total, used, unused } = calcFieldStats(field);

    const rate = total > 0 ? unused / total : 1;
    const unusedPct = Math.round(rate * 100);

    // 大数字 + 百分比
    valueEl.textContent = unused;
    pctEl.textContent = `${unusedPct}%`;    

    // 颜色随阈值变化
    if (unusedPct >= 50) {
      valueEl.style.color = '#2f9e44';
      pctEl.style.color = '#2f9e44';
      barFill.className = 'stat-card-bar-fill level-high';
    } else if (unusedPct >= 20) {
      valueEl.style.color = '#e67700';
      pctEl.style.color = '#e67700';
      barFill.className = 'stat-card-bar-fill level-mid';
    } else {
      valueEl.style.color = '#e03131';
      pctEl.style.color = '#e03131';
      barFill.className = 'stat-card-bar-fill level-low';
    }

    // 进度条宽度
    barFill.style.width = `${unusedPct}%`;

    // 底部明细
    footerEl.textContent = total > 0
      ? t('stat.detail', { unused, used, total })
      : t('stat.noData');
  }
}

// ─── 批次管理 ───

/**
 * 刷新批次列表。
 * @param {string} [selectBatch] 启动恢复 / 抓取新建时指定的批次名：
 *   - 存在且仍在列表 → 自动加载该批次（loadBatch 会持久化 lastBatch）
 *   - 存在但已丢失/异常 → 不加载任何批次，等待用户手动选择
 *   - 未指定（首次运行/无记录）→ 沿用默认：加载第一个批次
 */
async function refreshBatches(selectBatch) {
  const batches = await window.api.batches();
  state.batches = batches;
  // __all__ 是聚合模式，不在 batches 列表内，单独接受
  const isAllSelect = selectBatch === '__all__';
  if (!batches.length && !isAllSelect) {
    state.batch = null;
    $('#batch-label').textContent = '—';
    renderBatchList();
    renderStats();
    return false;
  }
  // 明确指定了批次（config.yaml 记录的 lastBatch 或抓取新建批次）且该批次仍存在
  // __all__ 视为合法的「选中」状态：只要存在任意批次即可加载（聚合所有）
  if (isAllSelect || (selectBatch && batches.includes(selectBatch))) {
    const target = isAllSelect ? '__all__' : selectBatch;
    state.batch = target;
    $('#batch-label').textContent = isAllSelect ? t('batch.all') : target;
    await loadBatchUsage();
    renderBatchList();
    await loadBatch(target);
    return true;
  }
  // 指定了批次但该批次已丢失/异常 → 不自动加载任何批次，等待用户手动选择
  if (selectBatch) {
    state.batch = null;
    $('#batch-label').textContent = '—';
    renderBatchList();
    renderStats();
    setStatusBar(t('msg.batchLost', { batch: selectBatch }), 'warn');
    return false;
  }
  // 未指定批次（首次运行/无记录）→ 沿用默认：加载第一个批次
  state.batch = batches[0];
  $('#batch-label').textContent = batches[0];
  await loadBatchUsage();
  renderBatchList();
  await loadBatch(batches[0]);
  return true;
}

async function loadBatch(batch) {
  const data = await window.api.loadBatch({ batch });
  state.batch = batch;
  state.entries = data.entries || [];
  state.used = new Set(data.used || []);
  // __all__ 模式：从每条 entry 的 __batch 标签建立 usedKey → 批次 的映射（用于导入/撤回按源批次回写）
  state.__allKeyToBatch = null;
  if (batch === '__all__') {
    state.__allKeyToBatch = new Map();
    for (const e of state.entries) {
      const k = e.kanji || e.raw || '';
      if (k && e.__batch && !state.__allKeyToBatch.has(k)) {
        state.__allKeyToBatch.set(k, e.__batch);
      }
    }
  }
  // 别名仅内存、按需求不持久化，切批次清空；手动绑定(batchBindings)跨批次保留，不清空
  state.aliases = {};
  renderList(); renderStats();
  $('#batch-label').textContent = batch === '__all__' ? t('batch.all') : batch;
  setStatusBar(batch === '__all__'
    ? t('msg.batchLoadedAll', { n: state.entries.length, batches: data.batches ? data.batches.length : 0 })
    : t('msg.batchLoaded', { batch, n: state.entries.length }), 'ok');
  // 记录当前打开的数据批次到 config.yaml（下次启动据此自动恢复）
  window.api.saveConfig({ lastBatch: batch }).catch(() => {});
}

function buildTargetUrl() {
  const g = $('#gender').value, p = $('#popularity').value;
  return `https://www.namechef.co/cn/name-generator/japanese/?gender=${g}&last_name_type=random&last_name=&popularity%5B%5D=${p}`;
}

// ⚡抓取
async function autoFetch() {
  const btn = $('#btn-auto');
  btn.disabled = true;
  setStatusBar(t('msg.cfChallenge'));
  let fileInfo = '';
  try {
    const { cookie, html } = await window.api.autoCf({ url: buildTargetUrl() });

    if (html && html.length > 500) {
      setStatusBar(t('msg.parsing'));
      const result = await window.api.collectFromHtml({ html });
      if (result.jsonPath) fileInfo = ` | JSON → ${result.jsonPath}`;
      await refreshBatches(result.batch);
      setStatusBar(t('msg.fetchOk', { n: state.entries.length, info: fileInfo }), 'ok');
    } else {
      setStatusBar(t('msg.gotCookie'));
      state.entries = await window.api.collect({
        cookie, gender: $('#gender').value, popularity: $('#popularity').value,
      });
      state.aliases = {};
      state.used = new Set();
      renderList(); renderStats();
      await refreshBatches();
      setStatusBar(t('msg.fetchOk', { n: state.entries.length, info: '' }), 'ok');
    }
  } catch (e) {
    setStatusBar(t('msg.fetchFail', { err: e.message || e }), 'err');
  } finally {
    btn.disabled = false;
  }
}

/**
 * 在「所有数据批次」耗尽时调用：自动抓取一批新名字并刷新批次列表。
 * 抓取成功 → 重新加载 __all__ 聚合视图，返回 true；
 * 抓取失败 → 返回 false（弹窗已给出错误提示）。
 */
async function tryAutoFetch() {
  setStatusBar(t('msg.cfChallenge'));
  try {
    const { cookie, html } = await window.api.autoCf({ url: buildTargetUrl() });
    let result;
    if (html && html.length > 500) {
      setStatusBar(t('msg.parsing'));
      result = await window.api.collectFromHtml({ html });
    } else {
      result = await window.api.collect({
        cookie, gender: $('#gender').value, popularity: $('#popularity').value,
      });
    }
    // 抓取后：刷新 batches 列表，并按当前 batch 类型重新加载
    if (state.batch === '__all__') {
      // 重新聚合所有批次
      await loadBatch('__all__');
      renderList(); renderStats(); refreshBatchUsage();
    } else {
      await refreshBatches(result.batch);
    }
    return true;
  } catch (e) {
    setStatusBar(t('msg.fetchFail', { err: e.message || e }), 'err');
    return false;
  }
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  if (!state.entries.length) {
    list.appendChild(el('div', 'empty', t('list.empty')));
    return;
  }
  const field = currentField();
  const view = sortedView();
  // 原始行号映射：绑定/别名按「批次内原始位置」记录，不随排序重排而错位
  const origIndex = new Map(state.entries.map((e, i) => [e, i]));

  view.forEach((e) => {
    const row = origIndex.get(e);
    const item = el('div', 'item');
    const key = usedKey(e);
    const isUsed = state.used.has(key);
    if (isUsed) item.classList.add('dim');

    // 小灯
    const light = el('span', 'light ' + (isUsed ? 'used' : 'unused'));
    light.title = isUsed ? t('tip.lightUsed') : t('tip.lightUnused');
    light.dataset.tip = isUsed ? t('tip.lightUsed') : t('tip.lightUnused');
    light.addEventListener('click', () => {
      if (state.used.has(key)) state.used.delete(key);
      else state.used.add(key);
      persistUsed().catch(() => {});
      renderList(); renderStats();
      refreshBatchUsage();  // 实时更新批次使用情况进度条
    });
    item.appendChild(light);

    // 名称三行（每行独立高亮 + 独立点击复制）
    const name = el('div', 'name');
    const addLine = (text, fieldKey, cls) => {
      if (!text) return;
      const line = el('div', cls + ' line', text);
      if (field === fieldKey) line.classList.add('hl');
      line.dataset.copy = text;
      line.addEventListener('mouseenter', () => line.classList.add('line-hover'));
      line.addEventListener('mouseleave', () => line.classList.remove('line-hover'));
      line.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await window.api.copyText({ text });
          setStatusBar(t('msg.copied', { text }), 'ok');
        } catch {
          setStatusBar(t('msg.copyFail', { text }), 'err');
        }
      });
      name.appendChild(line);
    };
    addLine(e.kanji || e.raw || '?', 'kanji', 'kanji');
    addLine(e.romaji, 'romaji', 'sub');
    addLine(e.hiragana, 'hiragana', 'sub');
    item.appendChild(name);

    // 绑定输入框 + 锁定（手动/手动全局模式均可编辑和锁定）
    const bindingVal = $('#binding').value;
    if (bindingVal === 'manual' || bindingVal === 'manualGlobal') {
      const isManualGlobal = (bindingVal === 'manualGlobal');
      let displayCode = '';
      // 取当前生效的编码
      if (isManualGlobal) {
        // 手动(全局)：从全局默认绑定取编码
        const gb = state.batchBindings[GLOBAL_KEY];
        const gRow = gb && gb[row];
        displayCode = (gRow && gRow.identifier) || '';
      } else {
        // 手动：仅取批次级绑定（不回退全局）
        const b = getRowBinding(row, { noGlobalFallback: true });
        displayCode = b ? b.identifier : '';
      }

      // 手动/手动(全局)统一使用可编辑输入框 + 锁定按钮
      const b = isManualGlobal
        ? ((state.batchBindings[GLOBAL_KEY] || {})[row] || null)
        : getRowBinding(row, { noGlobalFallback: true });
      const fromGlobal = !isManualGlobal && !!(b && b.global);
      const locked = !!(b && b.locked);
      const code = el('input', 'code');
      code.placeholder = t('ph.binding');
      code.value = (b && b.identifier) || '';
      if (fromGlobal) {
        code.classList.add('from-global');
        code.dataset.tip = t('tip.globalBinding');
      } else {
        code.dataset.tip = t('tip.codeInput');
      }
      const disableEdit = locked && !fromGlobal;
      code.disabled = disableEdit;
      code.classList.toggle('locked', disableEdit);
      code.addEventListener('input', () => {
        code.classList.remove('from-global');
        if (isManualGlobal) {
          // 手动(全局)：写入全局默认绑定
          const gBindings = state.batchBindings[GLOBAL_KEY] = state.batchBindings[GLOBAL_KEY] || {};
          const cur = gBindings[row] || { identifier: '', locked: false };
          const next = { ...cur, identifier: code.value.trim(), locked: cur.locked };
          if (!next.identifier && !next.locked) delete gBindings[row];
          else gBindings[row] = next;
          persistGlobalBindings();
        } else {
          const cur = getRowBinding(row, { noGlobalFallback: true });
          setRowBinding(row, { identifier: code.value.trim(), locked: cur ? cur.locked : false });
        }
      });
      item.appendChild(code);

      const lock = el('button', 'lock', locked ? '🔒' : '🔓');
      lock.title = t('tip.lock');
      lock.dataset.tip = t('tip.lock');
      lock.classList.toggle('on', locked);
      lock.addEventListener('click', () => {
        if (isManualGlobal) {
          // 手动(全局)：操作全局绑定
          const gBindings = state.batchBindings[GLOBAL_KEY] = state.batchBindings[GLOBAL_KEY] || {};
          const cur = gBindings[row] || { identifier: '', locked: false };
          const isLocked = !!cur.locked;
          if (isLocked) {
            const next = { locked: false, identifier: cur.identifier || '' };
            if (!next.identifier) delete gBindings[row];
            else gBindings[row] = next;
            setStatusBar(t('msg.unlocked', { row: row + 1 }), 'ok');
          } else {
            const identifier = cur.identifier || code.value.trim();
            if (!identifier) { setStatusBar(t('msg.lockNeedCode'), 'err'); return; }
            gBindings[row] = { locked: true, identifier };
            setStatusBar(t('msg.locked', { row: row + 1 }), 'ok');
          }
          persistGlobalBindings();
        } else {
          // 手动：原有逻辑
          const cur = getRowBinding(row);
          const isLocked = !!(cur && cur.locked);
          if (isLocked) {
            setRowBinding(row, { locked: false, identifier: (cur && cur.identifier) || '' });
            setStatusBar(t('msg.unlocked', { row: row + 1 }), 'ok');
          } else {
            const identifier = (cur && cur.identifier) || code.value.trim();
            if (!identifier) { setStatusBar(t('msg.lockNeedCode'), 'err'); return; }
            setRowBinding(row, { locked: true, identifier });
            setStatusBar(t('msg.locked', { row: row + 1 }), 'ok');
          }
        }
        renderList();
      });
      item.appendChild(lock);
    }

    const add = el('button', 'add', '＋');
    add.title = t('tip.addAlias');
    add.dataset.tip = t('tip.addAlias');
    add.addEventListener('click', () => {
      (state.aliases[row] ||= []).push('');
      renderList();
      const inputs = list.querySelectorAll('.alias input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    item.appendChild(add);

    list.appendChild(item);

    // 别名行
    (state.aliases[row] || []).forEach((al, ai) => {
      const a = el('div', 'alias');
      const ain = el('input');
      ain.placeholder = t('ph.alias', { n: ai + 1 });
      ain.value = al;
      ain.dataset.tip = t('tip.aliasInput');
      ain.addEventListener('input', () => { state.aliases[row][ai] = ain.value.trim(); });
      a.appendChild(ain);
      const del = el('button', null, '×');
      del.title = t('tip.aliasDel');
      del.dataset.tip = t('tip.aliasDel');
      del.addEventListener('click', () => { state.aliases[row].splice(ai, 1); renderList(); });
      a.appendChild(del);
      list.appendChild(a);
    });
  });
}

// ─── 一键导入 ───

async function doImport(allowRefetch = true) {
  if (!state.entries.length) {
    // __all__ 模式下若还没数据，先尝试抓一次
    if (state.batch === '__all__') {
      const fetched = await tryAutoFetch();
      if (!fetched) { setStatusBar(t('msg.noImport'), 'err'); return; }
    } else {
      setStatusBar(t('msg.noImport'), 'err'); return;
    }
  }
  let count = Math.max(1, parseInt($('#count').value, 10) || 10);
  // 按绑定方式限位器钳制（手动 9999 / 英文键位顺序 26 / 流转顺序 12）
  const limit = currentLimit();
  if (count > limit) { count = limit; $('#count').value = count; persistConfig(); }

  // ⚠️ __all__ 模式：仅取「未使用」条目 —— 一键导入不复用已使用数据；
  //    若 count > 未用数量，由下方占位预览 + 多轮抓取补足。
  let view = (state.batch === '__all__')
    ? sortedView().filter((e) => !isEntryUsed(e))
    : sortedView();
  const slice = view.slice(0, count);
  const usedInSlice = slice.filter((e) => isEntryUsed(e));

  if (usedInSlice.length > 0) {
    const unusedTotal = view.length - view.filter((e) => isEntryUsed(e)).length;
    if (unusedTotal > 0) {
      // __all__ 模式：不调整导入数量；保持 count 不变，缺数据时由下方占位预览 + 多轮抓取流程补足
      if (state.batch !== '__all__') {
        // 检查「不再提醒」
        let cfgSkip = false;
        try {
          const cfgTmp = await window.api.loadConfig();
          cfgSkip = !!(cfgTmp && cfgTmp.skipUsedInSlice);
        } catch { /* 忽略 */ }
        if (!cfgSkip) {
          const previewItems = usedInSlice.map((e) => ({
            code: e.kanji || e.raw || '?',
            word: '',
            order: t('dialog.usedInSlice.rowTag'),
          }));
          const res = await showListDialog({
            titleKey: 'dialog.usedInSlice.title',
            bodyKey: 'dialog.usedInSlice.body',
            bodyParams: { count, used: usedInSlice.length, adj: Math.min(count, unusedTotal) },
            items: previewItems,
            itemRenderer: (it) => ({ code: it.code, word: '' }),
            confirmKey: 'dialog.usedInSlice.confirm',
            cancelKey: 'dialog.usedInSlice.cancel',
            skipKey: 'dialog.usedInSlice.skip',
          });
          if (!res.confirmed) { setStatusBar(t('msg.cancelled')); return; }
          if (res.skip) {
            window.api.saveConfig({ skipUsedInSlice: true }).catch(() => {});
          }
        }
        count = Math.min(count, unusedTotal);
        $('#count').value = count;
        persistConfig();
      }
    } else {
      // 数据全部使用过：__all__ 模式自动抓取填补，其他模式沿用原有确认弹窗
      if (state.batch === '__all__') {
        const fetched = await tryAutoFetch();
        if (!fetched) { setStatusBar(t('msg.cancelled')); return; }
        // 抓取后状态已刷新，递归重试一次
        return doImport();
      }
      const ok = confirm(t('confirm.allUsed', { count }));
      if (!ok) { setStatusBar(t('msg.cancelled')); return; }
    }
  }

  // ── 手动绑定模式：检测编码数量是否足够 ──
  if ($('#binding').value === 'manual') {
    const origIndex = new Map(state.entries.map((e, i) => [e, i]));
    const sliceForCheck = view.slice(0, count);
    let codedRows = 0;
    sliceForCheck.forEach((e) => {
      const row = origIndex.get(e);
      const b = getRowBinding(row, { noGlobalFallback: true });   // 仅批次级（不回退全局）
      if (b && b.identifier) codedRows++;
    });
    if (count > codedRows) {
      const action = await showDialog({
        title: t('dialog.manualBindShort.title'),
        body: t('dialog.manualBindShort.body', { count, coded: codedRows, missing: count - codedRows }),
        buttons: [
          { label: t('dialog.manualBindShort.autoQwerty'), cls: 'dialog-btn-primary', value: 'autoQwerty' },
          { label: t('dialog.manualBindShort.force'), cls: 'dialog-btn-secondary', value: 'force' },
          { label: t('dialog.manualBindShort.cancel'), cls: 'dialog-btn-cancel', value: 'cancel' },
        ],
      });
      if (action === 'cancel') { setStatusBar(t('msg.cancelled')); return; }
      if (action === 'autoQwerty') {
        // 将未绑定的行自动分配 qwerty 编码并持久化
        const qwertySeq = 'qwertyuiopasdfghjklzxcvbnm';
        let assignIdx = 0;
        sliceForCheck.forEach((e) => {
          const row = origIndex.get(e);
          const b = getRowBinding(row, { noGlobalFallback: true });
          if (!b || !b.identifier) {
            const code = qwertySeq[assignIdx++] || '';
            setRowBinding(row, { identifier: code, locked: false });
          }
        });
        renderList();
        setStatusBar(t('msg.autoAssigned', { n: assignIdx }), 'ok');
      }
      // 'force': 不做任何处理，直接继续（空编码行将导入为空）
    }
  }

  const config = {
    count, phraseField: $('#phraseField').value,
    bindingStrategy: $('#binding').value,
    lockedBindings: {},
    orderMode: $('#orderMode').value,
    orderValue: Math.max(1, parseInt($('#orderValue').value, 10) || 1),
  };

  // 手动绑定按「批次+原始行号」持久化（含全局回退），这里映射回本次导入的 slice 索引
  // 手动(全局)模式：编码直接从 __global__ 全局默认绑定取
  const origIndex = new Map(state.entries.map((e, i) => [e, i]));
  const lockedBindings = {};
  const aliases = {};
  const isManualGlobal = (config.bindingStrategy === 'manualGlobal');
  view.slice(0, count).forEach((e, i) => {
    const row = origIndex.get(e);
    if (isManualGlobal) {
      // 从全局默认绑定取编码
      const gb = state.batchBindings[GLOBAL_KEY];
      const gRow = gb && gb[row];
      if (gRow && gRow.identifier) lockedBindings[i] = gRow.identifier;
    } else {
      // 手动模式：仅取批次级绑定（不回退全局绑定）
      const b = getRowBinding(row, { noGlobalFallback: true });
      if (b && b.identifier) lockedBindings[i] = b.identifier;
    }
    if (state.aliases[row] && state.aliases[row].length) aliases[i] = state.aliases[row];
  });
  config.lockedBindings = lockedBindings;

  const pField = $('#phraseField').value;
  const bindingVal = $('#binding').value;

  // ── __all__ 模式且数量不足：先显示占位预览（黄色"确认后生成"），用户确认后多轮抓取，再二次预览导入 ──
  //    ⚠️ 该流程必须位于冲突检测（即将覆盖）之前：抓取完成后 view 已刷新，
  //    后续冲突检测与导入预览都基于最新数据。
  if (allowRefetch && state.batch === '__all__' && count > view.length) {
    const placeholderItems = [];
    for (let i = 0; i < count; i++) {
      let code = '';
      if (bindingVal === 'qwerty') code = 'qwertyuiopasdfghjklzxcvbnm'[i] || '';
      else if (bindingVal === 'qwerFlow') code = 'qwerasdfzxcv'[i] || '';
      else if (i < view.length) {
        const e0 = view[i];
        const row0 = origIndex.get(e0);
        const b0 = getRowBinding(row0, { noGlobalFallback: true });
        code = (b0 && b0.identifier) || '';
      }
      const ord = (config.orderMode === 'fixed' ? config.orderValue : (i + 1));
      const w = (i < view.length) ? (view[i][pField] || view[i].kanji || view[i].raw || '?') : t('fetch.progress.placeholder');
      placeholderItems.push({ code: code || '—', word: w, order: `第${ord}位`, _isPlaceholder: i >= view.length });
    }
    // 跳过「不再提醒」检查
    let cfgSkip = false;
    try {
      const cfgTmp = await window.api.loadConfig();
      cfgSkip = !!(cfgTmp && cfgTmp.skipImportPreview);
    } catch { /* 忽略 */ }
    let placeholderConfirmed = true;
    if (!cfgSkip) {
      const res = await showListDialog({
        titleKey: 'dialog.importPreview.title',
        bodyKey: 'dialog.importPreview.placeholderBody',
        bodyParams: { total: count, known: view.length, need: count - view.length },
        items: placeholderItems,
        itemRenderer: (it) => ({ code: it.code, word: it.word, order: it.order, _isPlaceholder: it._isPlaceholder }),
        confirmKey: 'dialog.importPreview.confirm',
        cancelKey: 'dialog.importPreview.cancel',
        skipKey: 'dialog.importPreview.skip',
      });
      placeholderConfirmed = res.confirmed;
      if (res.skip) window.api.saveConfig({ skipImportPreview: true }).catch(() => {});
    }
    if (!placeholderConfirmed) { setStatusBar(t('msg.cancelled')); return; }

    // 用户确认占位预览 → 触发多轮抓取（带进度弹窗 + 强制停止）
    const need = count - view.length;
    const fetched = await fetchMultipleWithProgress(need, {
      gender: $('#gender').value, popularity: $('#popularity').value, url: buildTargetUrl(),
    });
    if (!fetched || fetched.cancelled) {
      setStatusBar(t('msg.cancelled')); return;
    }
    if (!fetched.entries || fetched.entries.length === 0) {
      setStatusBar(t('msg.fetchFail', { err: '0 entries' }), 'err'); return;
    }
    // 抓取成功 → 重新聚合所有批次（含新批次）→ 递归 doImport（数据已足够，会走真实预览）
    await loadBatch('__all__');
    renderList(); renderStats(); refreshBatchUsage();
    // allowRefetch=false：递归时即使仍不足也不再抓（避免死循环），直接按现有数据继续
    return doImport(false);
  }

  // ── 冲突检测（auto + fixed 模式都跑）：让用户确认后再导入 ──
  let fixedOverwriteCount = 0;
  try {
    setStatusBar(t('msg.checkingConflict'));
    const resolveRes = await window.api.resolveOrders({ config, entries: view, aliases });
    if (config.orderMode === 'auto') {
      // auto：自动避让后的调整清单
      if (resolveRes.adjustments && resolveRes.adjustments.length > 0) {
        // 检查「不再提醒」
        let cfgSkip = false;
        try {
          const cfgTmp = await window.api.loadConfig();
          cfgSkip = !!(cfgTmp && cfgTmp.skipOrderAdjust);
        } catch { /* 忽略 */ }
        if (!cfgSkip) {
          const items = resolveRes.adjustments.map((a) => ({
            code: a.code,
            word: a.word,
            order: `${a.fromOrder}→${a.toOrder}`,
          }));
          const res = await showListDialog({
            titleKey: 'dialog.conflict.title',
            bodyKey: 'dialog.conflict.body',
            bodyParams: { n: resolveRes.adjustments.length },
            items,
            itemRenderer: (it) => ({ code: it.code, word: it.word, order: `第${it.order}位`, arrow: '→' }),
            confirmKey: 'dialog.conflict.confirm',
            cancelKey: 'dialog.conflict.cancel',
            skipKey: 'dialog.conflict.skip',
          });
          if (!res.confirmed) { setStatusBar(t('msg.cancelled')); return; }
          if (res.skip) window.api.saveConfig({ skipOrderAdjust: true }).catch(() => {});
        }
      }
    } else {
      // fixed：冲突 = 即将覆盖现有同 code+order 的词条，提示用户确认
      fixedOverwriteCount = (resolveRes.adjustments && resolveRes.adjustments.length) || 0;
      if (fixedOverwriteCount > 0) {
        // 检查「不再提醒」
        let cfgSkip = false;
        try {
          const cfgTmp = await window.api.loadConfig();
          cfgSkip = !!(cfgTmp && cfgTmp.skipOrderOverwrite);
        } catch { /* 忽略 */ }
        if (!cfgSkip) {
          const items = resolveRes.adjustments.map((a) => ({
            code: a.code,
            word: a.word,
            order: `第${a.fromOrder}位`,
          }));
          const res = await showListDialog({
            titleKey: 'dialog.orderOverwrite.title',
            bodyKey: 'dialog.orderOverwrite.body',
            bodyParams: { n: fixedOverwriteCount, order: config.orderValue },
            items,
            itemRenderer: (it) => ({ code: it.code, word: it.word, order: it.order, arrow: '·' }),
            confirmKey: 'dialog.orderOverwrite.confirm',
            cancelKey: 'dialog.orderOverwrite.cancel',
            skipKey: 'dialog.orderOverwrite.skip',
          });
          if (!res.confirmed) { setStatusBar(t('msg.cancelled')); return; }
          if (res.skip) window.api.saveConfig({ skipOrderOverwrite: true }).catch(() => {});
        }
      }
    }
    // 把解析后的真实候选位置缓存在 state 供预览使用
    state._resolvedRecords = resolveRes.records || null;
  } catch (e) {
    setStatusBar(t('msg.conflictFail', { err: e.message }), 'err');
    config.orderMode = 'fixed';
    state._resolvedRecords = null;
  }

  const previewItems = view.slice(0, count).map((e, i) => {
    let code = lockedBindings[i] || '';
    // 非手动模式：显示该绑定方式实际分配的键位编码
    if (!code && bindingVal !== 'manual' && bindingVal !== 'manualGlobal') {
      if (bindingVal === 'qwerty') code = 'qwertyuiopasdfghjklzxcvbnm'[i] || '';
      else if (bindingVal === 'qwerFlow') code = 'qwerasdfzxcv'[i] || '';
    }
    // 候选位置：fixed 模式统一用 orderValue；auto 模式用冲突解析后的真实 order；
    //              回退到 i+1（与原逻辑一致）
    const order = (state._resolvedRecords && state._resolvedRecords[i] && state._resolvedRecords[i].order)
      || (config.orderMode === 'fixed' ? config.orderValue : (i + 1));
    return { code: code || '—', word: e[pField] || e.kanji || e.raw || '?', order, _isPlaceholder: false };
  });
  state._resolvedRecords = null;

  // 检查是否已勾选"不再提醒"
  let cfgSkip = false;
  try {
    const cfgTmp = await window.api.loadConfig();
    cfgSkip = !!(cfgTmp && cfgTmp.skipImportPreview);
  } catch { /* 忽略 */ }

  let confirmed = true;
  if (!cfgSkip) {
    const previewRes = await showImportPreview(previewItems);
    confirmed = previewRes.confirmed;
    if (previewRes.skip) {
      // 用户勾选了"不再提醒"，持久化到配置
      window.api.saveConfig({ skipImportPreview: true }).catch(() => {});
    }
  }
  if (!confirmed) { setStatusBar(t('msg.cancelled')); return; }

  const btnImp = $('#btn-import'), btnUndo = $('#btn-undo');
  btnImp.disabled = true;
  setStatusBar(t('msg.importing'));
  try {
    const keysToAdd = view.slice(0, count).map((e) => usedKey(e));
    const res = await window.api.import({ config, entries: view, aliases });

    view.slice(0, count).forEach((e) => state.used.add(usedKey(e)));
    await persistUsed();
    renderList(); renderStats();
    refreshBatchUsage();  // 实时更新批次使用情况进度条

    state.lastImportInfo = { usedKeysAdded: keysToAdd, backupPath: res.backupPath, backups: res.backups };
    btnUndo.disabled = false;

    // 根据重载结果显示不同状态信息（默认精简，仅开发者模式显示完整路径）
    const files = [res.eudpTarget, res.udlTarget, res.legacyTarget].filter(Boolean).join(' + ');
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusSmart('msg.importOk.simple', { n: res.records.length },
                     'msg.importOk.full', { n: res.records.length, files });
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusSmart('msg.importPartial.simple', { n: res.records.length },
                     'msg.importPartial.full', { n: res.records.length, files, method });
    }
  } catch (e) {
    setStatusBar(t('msg.importFail', { err: e.message || e }), 'err');
  } finally {
    btnImp.disabled = false;
  }
}

// ─── 一键清除 ───

async function doClear() {
  // ⚠️ 与「导入预览」相同样式的应用内确认框（含「此后不再提醒」），替代浏览器原生 confirm
  let cfgSkip = false;
  try {
    const cfgTmp = await window.api.loadConfig();
    cfgSkip = !!(cfgTmp && cfgTmp.skipClearConfirm);
  } catch { /* 忽略 */ }
  let ok = true;
  if (!cfgSkip) {
    const res = await showListDialog({
      titleKey: 'dialog.clearConfirm.title',
      bodyKey: 'dialog.clearConfirm.body',
      items: [],
      itemRenderer: () => ({}),
      confirmKey: 'dialog.clearConfirm.confirm',
      cancelKey: 'dialog.clearConfirm.cancel',
      skipKey: 'dialog.clearConfirm.skip',
    });
    ok = res.confirmed;
    if (res.skip) window.api.saveConfig({ skipClearConfirm: true }).catch(() => {});
  }
  if (!ok) return;

  const btn = $('#btn-clear');
  btn.disabled = true;
  setStatusBar(t('msg.clearing'));
  try {
    const res = await window.api.clearIme();
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusSmart('msg.clearOk.simple', { n: res.originalCount },
                     'msg.clearOk.full', { n: res.originalCount, target: res.target });
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusSmart('msg.clearPartial.simple', { n: res.originalCount },
                     'msg.clearPartial.full', { n: res.originalCount, method });
    }
    state.lastImportInfo = { usedKeysAdded: [], backupPath: res.backupPath, backups: res.backups, wasClear: true };
    $('#btn-undo').disabled = false;
  } catch (e) {
    setStatusBar(t('msg.clearFail', { err: e.message || e }), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ─── 撤回 ───

async function doUndo() {
  if (!state.lastImportInfo) { setStatusBar(t('msg.noUndo')); return; }

  const info = state.lastImportInfo;
  const confirmMsg = info.wasClear
    ? t('confirm.undoClear')
    : t('confirm.undoImport', { n: info.usedKeysAdded.length });
  if (!confirm(confirmMsg)) return;

  const btn = $('#btn-undo');
  btn.disabled = true;
  setStatusBar(t('msg.undoing'));
  try {
    const res = await window.api.undoIme({ backupPath: info.backupPath, backups: info.backups });

    if (!info.wasClear && info.usedKeysAdded) {
      for (const k of info.usedKeysAdded) state.used.delete(k);
      await persistUsed();
    }

    state.lastImportInfo = null;
    renderList(); renderStats();
    refreshBatchUsage();  // 实时更新批次使用情况进度条
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusSmart('msg.undoOk.simple', null,
                     'msg.undoOk.full', { target: res.target });
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusSmart('msg.undoPartial.simple', null,
                     'msg.undoPartial.full', { target: res.target, method });
    }
  } catch (e) {
    setStatusBar(t('msg.undoFail', { err: e.message || e }), 'err');
    btn.disabled = false;
  }
}

// ─── 设置面板 ───

function toggleSettings(open) {
  const panel = $('#settings-panel');
  const next = open != null ? open : !panel.classList.contains('open');
  panel.classList.toggle('open', next);
  if (next) refreshApiStatus();
}

/**
 * 刷新设置面板中的本地 HTTP API 状态（端口 / 启用情况）。
 * API 已启用时，在下方显示 API 文档地址（{apiUrl}/api-docs.html）并可供点击在浏览器中打开；
 * API 禁用时隐藏该地址行。
 */
async function refreshApiStatus() {
  const elStatus = $('#api-status');
  const docRow = $('#api-doc-row');
  const docLink = $('#api-doc-link');
  if (!elStatus) return;
  try {
    const s = await window.api.apiStatus();
    const enabled = !!(s && s.enabled);
    elStatus.textContent = enabled ? t('set.api.on', { url: s.url || '' }) : t('set.api.off');
    elStatus.classList.toggle('on', enabled);
    // 文档地址行：启用时显示并拼接真实地址，禁用时隐藏
    if (enabled && docRow && docLink) {
      const docUrl = s.url ? `${s.url}/api-docs.html` : '';
      docRow.classList.remove('hidden');
      docLink.textContent = docUrl;
      docLink.href = docUrl;
      docLink.dataset.url = docUrl;
    } else if (docRow) {
      docRow.classList.add('hidden');
    }
  } catch {
    elStatus.textContent = '—';
    if (docRow) docRow.classList.add('hidden');
  }
}

/** 点击设置面板「本地API」状态文字 → 切换启停 */
async function toggleApiServer() {
  const elStatus = $('#api-status');
  if (!elStatus) return;
  elStatus.style.pointerEvents = 'none';
  try {
    const res = await window.api.apiToggle();
    if (res && res.error) {
      setStatusBar(t('msg.apiToggleFail', { err: res.error }), 'err');
    }
    await refreshApiStatus();
  } catch (e) {
    setStatusBar(t('msg.apiToggleFail', { err: e.message }), 'err');
  } finally {
    elStatus.style.pointerEvents = '';
  }
}

// 点击面板外部时自动收起
document.addEventListener('mousedown', (e) => {
  const panel = $('#settings-panel');
  if (!panel.classList.contains('open')) return;
  if (panel.contains(e.target) || e.target.closest('#btn-settings')) return;
  toggleSettings(false);
});

// 点击「本地API」状态文字 → 切换启停
$('#api-status')?.addEventListener('click', toggleApiServer);

// 点击 API 文档地址 → 在系统默认浏览器中打开
$('#api-doc-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  const url = e.currentTarget.dataset.url;
  if (url) window.api.openExternal({ path: url }).catch(() => {});
});

// 开发者提示模式开关：切换时立即生效 + 持久化
$('#set-devmode')?.addEventListener('change', async (e) => {
  const enabled = !!e.target.checked;
  state.config = state.config || {};
  state.config.devMode = enabled;
  try { await window.api.saveConfig({ devMode: enabled }); } catch {}
});

// 点击「关于」窗口中的 GitHub 链接 → 在系统默认浏览器中打开
$('#about-github')?.addEventListener('click', (e) => {
  e.preventDefault();
  const url = e.currentTarget.dataset.url;
  if (url) window.api.openExternal({ path: url }).catch(() => {});
});

// 语言切换（下拉由 lang-list 动态填充，选项文本即语言包的 language 属性）
$('#set-lang').addEventListener('change', async (e) => {
  const lang = e.target.value;
  await loadLang(lang);
  window.api.saveConfig({ lang }).catch(() => {});
  const opt = e.target.options[e.target.selectedIndex];
  setStatusBar(t('msg.langChanged', { lang: (opt && opt.textContent) || lang }), 'ok');
});

// 主题切换
$('#set-theme').addEventListener('change', (e) => {
  const theme = e.target.value;
  applyTheme(theme);
  window.api.saveConfig({ theme }).catch(() => {});
});

// 保存当前批次绑定为全局默认
$('#set-global-save').addEventListener('click', async () => {
  const rows = state.batchBindings[state.batch] || {};
  const n = Object.keys(rows).length;
  if (!n) { setStatusBar(t('msg.globalNone'), 'err'); return; }
  try {
    await window.api.saveGlobalBindings({ rows });
    state.batchBindings[GLOBAL_KEY] = JSON.parse(JSON.stringify(rows));
    renderList();
    setStatusBar(t('msg.globalSaved', { n }), 'ok');
  } catch (e) {
    setStatusBar(String(e.message || e), 'err');
  }
});

// 清除全局默认绑定
$('#set-global-clear').addEventListener('click', async () => {
  try {
    await window.api.saveGlobalBindings({ rows: {} });
    delete state.batchBindings[GLOBAL_KEY];
    renderList();
    setStatusBar(t('msg.globalCleared'), 'ok');
  } catch (e) {
    setStatusBar(String(e.message || e), 'err');
  }
});

// ─── 刷新：重载配置、语言、绑定、批次与列表 ───

async function refreshAll() {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  try {
  // 1. 配置（含语言/主题）
  let cfg = null;
  try { cfg = await window.api.loadConfig(); } catch { /* 保持现状 */ }
  await populateLangSelect();
  await loadShortcuts();   // 加载快捷键配置（含录制/禁用状态）
  if (cfg) {
    applyTheme(cfg.theme || 'system');
    await loadLang(cfg.lang || 'zh-CN');
    try { applyConfigToUi(cfg); } catch { /* 保持现状 */ }
  }
    applyBindingLimit();
    // 2. 手动绑定
    try { state.batchBindings = (await window.api.loadBindings()) || {}; } catch { /* 保持现状 */ }
    // 3. 批次与列表（保持当前选中批次）
    await refreshBatches(state.batch);
    setStatusBar(t('msg.refreshed'), 'ok');
  } finally {
    btn.disabled = false;
  }
}

// ─── 关闭按钮：询问 / 直接关闭 / 最小化（可记忆选择） ───

/**
 * 处理关闭按钮点击：
 * 1. 读取 config.yaml 的 closeBehavior
 * 2. 'ask' → 弹出选择模态框
 * 3. 'close' → 直接关闭应用
 * 4. 'minimize' → 最小化窗口
 */
async function handleClose() {
  try {
    const cfg = await window.api.loadConfig();
    const behavior = cfg && cfg.closeBehavior || 'ask';
    if (behavior === 'close') { window.api.close(); return; }
    if (behavior === 'minimize') { window.api.minimize(); return; }
    // 'ask' → 显示模态框
    showCloseModal();
  } catch {
    // 配置读取失败时默认直接关闭
    window.api.close();
  }
}

/** 显示关闭确认模态框 */
function showCloseModal() {
  const modal = $('#close-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // 重置记住选项状态
  const cb = $('#close-modal-remember');
  if (cb) cb.checked = false;
}

/** 隐藏关闭模态框 */
function hideCloseModal() {
  const modal = $('#close-modal');
  if (modal) modal.classList.add('hidden');
}

/** 显示「关于」窗口 */
function showAbout() {
  const modal = $('#about-modal');
  if (modal) modal.classList.remove('hidden');
}

/** 隐藏「关于」窗口 */
function hideAbout() {
  const modal = $('#about-modal');
  if (modal) modal.classList.add('hidden');
}

// ─── 版本管理（检查更新 / 回滚历史版本，只换 asar）───
let versionBusy = false;

function showVersion() {
  $('#version-modal')?.classList.remove('hidden');
  loadVersions();
}
function hideVersion() {
  $('#version-modal')?.classList.add('hidden');
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function loadVersions() {
  const statusEl = $('#version-status');
  const hintEl = $('#version-hint');
  if (statusEl) statusEl.textContent = t('ver.checking');
  if (hintEl) hintEl.textContent = '';
  try {
    const { running, latest, versions } = await window.api.updaterList();
    if (statusEl) {
      statusEl.innerHTML = '';
      const cur = document.createElement('div');
      cur.textContent = t('ver.current', { version: running });
      const lat = document.createElement('div');
      lat.textContent = t('ver.latest', { version: latest });
      statusEl.appendChild(cur);
      statusEl.appendChild(lat);
      if (compareSemver(latest, running) > 0) {
        const up = document.createElement('div');
        up.className = 'ver-update';
        up.textContent = t('ver.hasUpdate', { version: latest });
        statusEl.appendChild(up);
      } else {
        const ok = document.createElement('div');
        ok.className = 'ver-uptodate';
        ok.textContent = t('ver.upToDate');
        statusEl.appendChild(ok);
      }
    }
    renderVersionList(versions, running);
  } catch (e) {
    if (statusEl) statusEl.textContent = t('ver.fail', { err: (e && e.message) || e });
  }
}

function renderVersionList(versions, running) {
  const listEl = $('#version-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  [...versions].reverse().forEach((v) => {
    const card = document.createElement('div');
    card.className = 'ver-card ver-' + v.state;

    const top = document.createElement('div');
    top.className = 'ver-card-top';
    const name = document.createElement('span');
    name.className = 'ver-name';
    name.textContent = 'v' + v.version;
    const tag = document.createElement('span');
    tag.className = 'ver-tag ver-tag-' + v.state;
    tag.textContent = v.state === 'running' ? t('ver.running') : v.state === 'newer' ? t('ver.preview') : t('ver.older');
    top.appendChild(name);
    top.appendChild(tag);
    if (v.mandatory) {
      const m = document.createElement('span');
      m.className = 'ver-tag ver-tag-must';
      m.textContent = t('ver.mandatory');
      top.appendChild(m);
    }

    const meta = document.createElement('div');
    meta.className = 'ver-meta';
    meta.textContent = `${t('ver.pubAt')}：${v.pubAt || '-'}`;

    const notes = document.createElement('div');
    notes.className = 'ver-notes';
    notes.textContent = v.notes || '';

    const actions = document.createElement('div');
    actions.className = 'ver-actions';
    if (v.state === 'running') {
      const cur = document.createElement('span');
      cur.className = 'ver-cur';
      cur.textContent = t('ver.runningNow');
      actions.appendChild(cur);
    } else {
      const btn = document.createElement('button');
      btn.className = 'vbtn ver-switch';
      btn.textContent = t('ver.switch');
      btn.dataset.version = v.version;
      btn.addEventListener('click', () => switchVersion(v.version));
      actions.appendChild(btn);
    }

    card.appendChild(top);
    card.appendChild(meta);
    if (v.notes) card.appendChild(notes);
    card.appendChild(actions);
    listEl.appendChild(card);
  });
}

async function switchVersion(version) {
  if (versionBusy) return;
  versionBusy = true;
  const hintEl = $('#version-hint');
  const btn = document.querySelector(`.ver-switch[data-version="${version}"]`);
  const setBusy = (txt) => { if (hintEl) hintEl.textContent = txt; };
  try {
    setBusy(t('ver.switching'));
    if (btn) { btn.disabled = true; btn.textContent = t('ver.switching'); }
    const res = await window.api.updaterSwitch({ version });
    if (res && res.applied) {
      setBusy(t('ver.applied'));
      if (confirm(t('ver.appliedRestart'))) await window.api.updaterRestart();
    } else if (res && res.pending) {
      setBusy(t('ver.appliedPending'));
      if (confirm(t('ver.appliedRestart'))) await window.api.updaterRestart();
    } else {
      setBusy(t('ver.fail', { err: 'unknown' }));
    }
  } catch (e) {
    setBusy(t('ver.fail', { err: (e && e.message) || e }));
  } finally {
    versionBusy = false;
  }
  loadVersions();
}

/** 用户在模态框中选择操作 */
async function onCloseChoice(action) {
  const cb = $('#close-modal-remember');
  if (cb && cb.checked) {
    try {
      await window.api.saveConfig({ closeBehavior: action });
    } catch { /* 忽略保存失败 */ }
  }
  hideCloseModal();
  if (action === 'close') {
    window.api.close();
  } else {
    window.api.minimize();
  }
}

// ─── 事件绑定 ───

$('#btn-auto').addEventListener('click', autoFetch);
$('#btn-import').addEventListener('click', doImport);
$('#btn-clear').addEventListener('click', doClear);
$('#btn-undo').addEventListener('click', doUndo);
$('#btn-close').addEventListener('click', handleClose);
$('#btn-min').addEventListener('click', () => window.api.minimize());
$('#btn-settings').addEventListener('click', () => toggleSettings());
$('#btn-refresh').addEventListener('click', refreshAll);

// 关闭模态框按钮
$('#close-modal-close')?.addEventListener('click', () => onCloseChoice('close'));
$('#close-modal-minimize')?.addEventListener('click', () => onCloseChoice('minimize'));

// 关于窗口：i 按钮打开、关闭按钮与点击遮罩关闭
$('#btn-info')?.addEventListener('click', showAbout);
$('#about-close')?.addEventListener('click', hideAbout);
$('#about-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'about-modal') hideAbout();
});
// 版本管理弹窗：设置面板「版本」按钮打开、关闭/遮罩关闭、检查更新
$('#set-version')?.addEventListener('click', showVersion);
$('#version-close')?.addEventListener('click', hideVersion);
$('#version-modal')?.addEventListener('click', (e) => { if (e.target.id === 'version-modal') hideVersion(); });
$('#version-check')?.addEventListener('click', loadVersions);
// 更新进度 / 日志（一次性注册，直接刷新提示区）
window.api.onUpdaterProgress((p) => {
  const hintEl = $('#version-hint');
  if (hintEl && p && p.phase === 'download') hintEl.textContent = t('ver.download', { pct: p.pct || 0 });
});
window.api.onUpdaterLog((p) => {
  const hintEl = $('#version-hint');
  if (hintEl && p && p.msg) hintEl.textContent = p.msg;
});
// 点击模态框背景层关闭
$('#close-modal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) hideCloseModal(); });

// 暴露动作接口：供外部脚本 / 开发工具以 api 方式触发
// 「抓取 / 一键导入 / 一键清除 / 撤回 / 切换短语字段」效果（快捷键直接调用本地函数，不依赖此暴露）
try {
  window.api.capture = autoFetch;
  window.api.doImport = doImport;
  window.api.doClear = doClear;
  window.api.doUndo = doUndo;
  window.api.togglePhraseField = togglePhraseField;
} catch {
  // 个别环境 contextBridge 对象只读，退而挂载到独立命名空间
  window.__appActions = { capture: autoFetch, doImport, doClear, doUndo, togglePhraseField };
}

// 固定到窗口最前面（切换 alwaysOnTop，并持久化到 config.yaml）
$('#btn-pin').addEventListener('click', async () => {
  try {
    const res = await window.api.toggleAlwaysOnTop();
    $('#btn-pin').classList.toggle('pin-active', !!res.pinned);
    window.api.saveConfig({ pinned: !!res.pinned }).catch(() => {});
    if (res.pinned) syncShortcutsToMain();   // 置顶开启：把当前 enabled 快捷键上报主进程供 globalShortcut 注册
    setStatusBar(res.pinned ? t('msg.pinned') : t('msg.unpinned'), 'ok');
  } catch {
    setStatusBar(t('msg.pinFail'), 'err');
  }
});

// 隐藏提示栏
$('#btn-hide-status').addEventListener('click', () => {
  $('.status-bar-wrap').classList.add('hidden');
  $('#btn-hide-status').classList.remove('visible');
});

// 批次下拉：点击按钮展开/收起；点击外部收起
$('#batch-btn').addEventListener('click', async () => {
  if ($('#batch-list').classList.contains('hidden')) {
    // ⚠️ 每次展开都主动从主进程读取最新批次列表 + 使用情况，避免被动刷新导致新批次不显示
    try {
      const batches = await window.api.batches();
      state.batches = batches;
      await loadBatchUsage();
    } catch { /* 读取失败则沿用缓存 */ }
    renderBatchList();
    openBatchList();
  } else {
    closeBatchList();
  }
});
document.addEventListener('mousedown', (e) => {
  const wrap = document.querySelector('.batch-select');
  if (!wrap) return;
  if (wrap.contains(e.target)) return;
  closeBatchList();
});

// 绑定方式下拉：点击按钮展开/收起；点击外部收起
$('#binding-btn').addEventListener('click', () => {
  if ($('#binding-list').classList.contains('hidden')) { renderBindingList(); openBindingList(); }
  else closeBindingList();
});
document.addEventListener('mousedown', (e) => {
  const wrap = document.querySelector('.binding-select');
  if (!wrap) return;
  if (wrap.contains(e.target)) return;
  closeBindingList();
});
// 短语字段变更：重算统计 + 重新拉取各批次使用情况并重绘下拉
$('#phraseField').addEventListener('change', async () => {
  renderList(); renderStats();
  await loadBatchUsage();
  renderBatchList();
});

// 点击上方仪表卡快速切换当前短语字段（汉字 / 罗马音 / 平假名）
document.querySelectorAll('.stat-card').forEach((card) => {
  card.addEventListener('click', () => {
    const field = card.dataset.field;
    if (!field) return;
    const sel = $('#phraseField');
    if (sel.value === field) return;   // 已是当前字段，无需重复
    sel.value = field;
    sel.dispatchEvent(new Event('change'));   // 触发与下拉一致的重绘 + 持久化
  });
});

// 快捷键 Alt+B：循环切换当前短语字段（汉字 → 罗马音 → 平假名）
function togglePhraseField() {
  const sel = $('#phraseField');
  const opts = ['kanji', 'romaji', 'hiragana'];
  const idx = opts.indexOf(sel.value);
  const next = opts[(idx + 1) % opts.length];
  sel.value = next;
  sel.dispatchEvent(new Event('change'));   // 复用下拉一致的重绘 + 持久化
  setStatusBar(t('msg.fieldSwitched', { field: t('field.' + next) }), 'ok');
}

// ─── 快捷键：自定义组合键 + 启用/禁用（持久化到 data/shortcuts.json） ───
// 5 个可触发动作（与 window.api.* 一一对应）；出厂默认 Alt+X/V/C/Z/B
const SHORTCUT_ACTIONS = [
  { key: 'capture', labelKey: 'fetch', fn: () => autoFetch() },
  { key: 'doImport', labelKey: 'import', fn: () => doImport() },
  { key: 'doClear', labelKey: 'clear', fn: () => doClear() },
  { key: 'doUndo', labelKey: 'undo', fn: () => doUndo() },
  { key: 'togglePhraseField', labelKey: 'toggleField', fn: () => togglePhraseField() },
];

function defaultShortcuts() {
  return {
    capture: { combo: 'Alt+X', enabled: true },
    doImport: { combo: 'Alt+V', enabled: true },
    doClear: { combo: 'Alt+C', enabled: true },
    doUndo: { combo: 'Alt+Z', enabled: true },
    togglePhraseField: { combo: 'Alt+B', enabled: true },
  };
}

/** 从键盘事件规范化组合键字符串：修饰键(Ctrl/Alt/Shift/Meta)在前 + 主键，字母大写。
 *  纯修饰键（无主键）返回 null，等待主键。 */
function comboFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  let key = e.key;
  if (key == null) return null;
  if (key === ' ') key = 'Space';
  // 仅按下修饰键本身（key 为 Control/Alt/Shift/Meta）→ 无主键，返回 null
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join('+');
}

/** 把当前 enabled 快捷键同步到主进程（置顶时主进程会注册为 globalShortcut） */
function syncShortcutsToMain() {
  try {
    const sc = state.shortcuts || defaultShortcuts();
    const list = SHORTCUT_ACTIONS
      .filter((a) => sc[a.key] && sc[a.key].enabled && sc[a.key].combo)
      .map((a) => ({ combo: sc[a.key].combo, action: a.key, enabled: true }));
    window.api.setGlobalShortcuts({ shortcuts: list }).catch(() => {});
  } catch { /* 静默 */ }
}

/** 监听主进程通过 globalShortcut 触发的快捷键动作（来自 webContents.send('trigger-shortcut')） */
if (window.api && window.api.onTriggerShortcut) {
  window.api.onTriggerShortcut(({ action } = {}) => {
    const a = SHORTCUT_ACTIONS.find((x) => x.key === action);
    if (a) a.fn();
  });
}

/** 读取并缓存快捷键配置（缺失时回退默认） */
async function loadShortcuts() {
  try { state.shortcuts = (await window.api.shortcutsLoad()) || defaultShortcuts(); }
  catch { state.shortcuts = defaultShortcuts(); }
  renderShortcuts();
  syncShortcutsToMain();
}

function persistShortcuts() {
  window.api.shortcutsSave(state.shortcuts).catch(() => {});
}

/** 渲染设置面板中的快捷键列表：组合键 + 录制按钮；点击标签区域切换启用/禁用 */
function renderShortcuts() {
  const list = $('#shortcut-list');
  if (!list) return;
  list.innerHTML = '';
  const sc = state.shortcuts || defaultShortcuts();
  SHORTCUT_ACTIONS.forEach(({ key, labelKey }) => {
    const s = sc[key] || { combo: '', enabled: true };
    const row = el('div', 'shortcut-item' + (s.enabled ? '' : ' disabled'));
    row.dataset.tipCall = 'window.api.' + key + '()';
    row.dataset.tip = t('act.' + labelKey + '.tip');
    const left = el('div', 'shortcut-left');
    // 点击左侧区域（标签+组合键）切换启用/禁用
    left.style.cursor = 'pointer';
    left.addEventListener('click', () => toggleShortcut(key));
    left.appendChild(el('span', 'shortcut-label', t('act.' + labelKey)));
    left.appendChild(el('kbd', 'shortcut-combo', s.combo || '—'));
    const right = el('div', 'shortcut-right');
    const rec = el('button', 'shortcut-rec' + (state.recording === key ? ' recording' : ''),
      state.recording === key ? t('set.shortcut.editing') : t('set.shortcut.edit'));
    rec.addEventListener('click', (ev) => { ev.stopPropagation(); startRecording(key); });
    right.appendChild(rec);
    row.append(left, right);
    list.appendChild(row);
  });
}

function startRecording(key) {
  state.recording = key;
  renderShortcuts();
  setStatusBar(t('shortcut.recording'), 'warn');
}

function stopRecording() {
  state.recording = null;
  renderShortcuts();
}

function toggleShortcut(key) {
  const sc = state.shortcuts || (state.shortcuts = defaultShortcuts());
  sc[key] = sc[key] || { combo: '', enabled: true };
  sc[key].enabled = !sc[key].enabled;
  persistShortcuts();
  renderShortcuts();
  syncShortcutsToMain();
}

// 全局快捷键：按用户自定义组合键触发（最多 3 键），支持录制与禁用
document.addEventListener('keydown', (e) => {
  // 录制模式：捕获下一次组合键作为该动作的快捷键
  if (state.recording) {
    e.preventDefault();
    if (e.key === 'Escape') { stopRecording(); setStatusBar(t('msg.cancelled')); return; }
    const combo = comboFromEvent(e);
    if (!combo) return;                       // 仅修饰键，等待主键
    if (combo.split('+').length > 3) {        // 组合超过 3 个按键 → 不合法
      stopRecording();
      setStatusBar(t('shortcut.invalid'), 'err');
      return;
    }
    const key = state.recording;
    state.recording = null;
    const sc = state.shortcuts || (state.shortcuts = defaultShortcuts());
    sc[key] = { combo, enabled: true };
    persistShortcuts();
    renderShortcuts();
    syncShortcutsToMain();
    setStatusBar(t('shortcut.captured', { combo }), 'ok');
    return;
  }
  // 正常触发模式
  const combo = comboFromEvent(e);
  if (!combo) return;
  // 裸键（无修饰键）且焦点在输入框 → 不触发，避免劫持输入
  const tag = (e.target && e.target.tagName) || '';
  const hasMod = /Ctrl|Alt|Shift|Meta/.test(combo);
  if (!hasMod && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
  const sc = state.shortcuts || {};
  for (const a of SHORTCUT_ACTIONS) {
    const s = sc[a.key];
    if (s && s.enabled && s.combo === combo) {
      e.preventDefault();
      a.fn();
      return;
    }
  }
});

['#gender', '#popularity', '#phraseField', '#binding', '#orderMode'].forEach((sel) => {
  $(sel).addEventListener('change', persistConfig);
});
// 切换候选位置模式时同步显示/隐藏固定值输入框
$('#orderMode').addEventListener('change', () => { updateOrderValueVisibility(); });
$('#orderValue').addEventListener('input', () => { syncOrderFixedLabel(); persistConfig(); });
$('#count').addEventListener('input', persistConfig);
$('#count').addEventListener('change', () => { clampCount(); persistConfig(); });

// 数量输入框：原生 ↑/↓ 按钮已处理 ±1；右击切换最大值/最小值（受限位器约束）
$('#count').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const limit = currentLimit();
  const v = parseInt($('#count').value, 10) || 1;
  // 已在最大值 → 切到最小(1)；否则切到最大
  $('#count').value = (v >= limit) ? '1' : String(limit);
  persistConfig();
});

// 删除当前批次的全部手动绑定（不影响其他批次）
$('#set-batch-clear').addEventListener('click', async () => {
  if (!state.batch) { setStatusBar(t('msg.noBatch'), 'err'); return; }
  try {
    await window.api.saveBindings({ batch: state.batch, rows: {} });
    delete state.batchBindings[state.batch];
    renderList();
    setStatusBar(t('msg.batchBindCleared', { batch: state.batch }), 'ok');
  } catch (e) {
    setStatusBar(String(e.message || e), 'err');
  }
});

// ─── 批次右击上下文菜单：删除数据批次（级联删除关联绑定） ───
function showBatchCtxMenu(x, y, batch) {
  const m = $('#batch-ctx-menu');
  if (!m) return;
  m.dataset.batch = batch;
  m.classList.remove('hidden');
  const w = m.offsetWidth || 120;
  const h = m.offsetHeight || 30;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - h - 4) + 'px';
}

function hideBatchCtxMenu() {
  const m = $('#batch-ctx-menu');
  if (m) m.classList.add('hidden');
}

// 点击菜单「删除批次」→ 二次确认 → 确认后才真正删除
$('#batch-ctx-menu .ctx-del').addEventListener('click', async () => {
  const m = $('#batch-ctx-menu');
  const batch = m && m.dataset.batch;
  hideBatchCtxMenu();
  if (!batch) return;
  const action = await showDialog({
    title: t('dialog.deleteBatch.title'),
    body: t('dialog.deleteBatch.body', { batch }),
    buttons: [
      { label: t('dialog.deleteBatch.confirm'), cls: 'dialog-btn-primary', value: 'confirm' },
      { label: t('dialog.deleteBatch.cancel'), cls: 'dialog-btn-cancel', value: 'cancel' },
    ],
  });
  if (action !== 'confirm') { setStatusBar(t('msg.cancelled')); return; }
  try {
    const res = await window.api.deleteBatch({ batch });
    if (!res || !res.ok) throw new Error((res && res.error) || 'unknown');
    delete state.batchBindings[batch];   // 内存中同步移除该批次绑定
    // 若删除的是当前批次，自动切到其余批次之一（或清空）
    await refreshBatches(state.batch === batch ? null : state.batch);
    // 当所有数据批次都被删除、切换到无任何数据批次的状态时，需刷新页面以正确渲染空态
    if (!state.batches.length) {
      setStatusBar(t('msg.batchDeleted', { batch }), 'ok');
      location.reload();
      return;
    }
    setStatusBar(t('msg.batchDeleted', { batch }), 'ok');
  } catch (err) {
    setStatusBar(t('msg.batchDeleteFailed', { msg: String(err.message || err) }), 'err');
  }
});

// 在菜单之外点击/按下 → 隐藏上下文菜单
document.addEventListener('mousedown', (e) => {
  const m = $('#batch-ctx-menu');
  if (m && !m.classList.contains('hidden') && !m.contains(e.target)) hideBatchCtxMenu();
});

// ─── 新手引导提示气泡 ───
// 悬停任意带 [data-tip] 的控件时，在鼠标旁显示其作用说明。
function initTooltips() {
  const tip = el('div', 'tooltip');
  tip.id = 'tooltip';
  document.body.appendChild(tip);
  let tipTarget = null;

  const show = (target) => {
    const call = target.getAttribute('data-tip-call') || '';
    const text = target.getAttribute('data-tip') || '';
    if (!call && !text) { tip.classList.remove('show'); return; }
    // 用受控子节点渲染：API 调用方式（等宽代码块）+ 作用描述，避免注入且样式分离
    tip.innerHTML = '';
    if (call) {
      const code = document.createElement('code');
      code.className = 'tip-call';
      code.textContent = call;
      tip.appendChild(code);
    }
    if (text) {
      const desc = document.createElement('div');
      desc.className = 'tip-desc';
      desc.textContent = text;
      tip.appendChild(desc);
    }
    tip.classList.add('show');
  };
  const position = (x, y) => {
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 18;
    if (left + r.width > window.innerWidth) left = x - r.width - 14;
    if (top + r.height > window.innerHeight) top = y - r.height - 18;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
  };

  document.addEventListener('mouseover', (e) => {
    const t2 = e.target.closest && e.target.closest('[data-tip]');
    if (t2 && t2 !== tipTarget) { tipTarget = t2; show(t2); }
  });
  document.addEventListener('mouseout', (e) => {
    const t2 = e.target.closest && e.target.closest('[data-tip]');
    if (t2 && t2 === tipTarget) { tipTarget = null; tip.classList.remove('show'); }
  });
  document.addEventListener('mousemove', (e) => {
    if (tipTarget) position(e.clientX, e.clientY);
  });
}

// 启动：先检测配置完整性（异常则弹框，可隔离并重载），再初始化应用
(async () => {
  initTooltips();
  await checkConfigIntegrity();
  await initApp();
})();

// 初始化应用（封装为可重跑函数，供「隔离并重载」后重新加载）
async function initApp() {
  let cfg = null;
  try { cfg = await window.api.loadConfig(); } catch { /* 默认值 */ }
  // 缓存到 state 供 devModeOn() 等读取（含 devMode/apiEnabled/...）
  state.config = cfg || {};

  // 先填充语言下拉，保证 applyConfigToUi 能正确选中当前语言
  await populateLangSelect();
  // 加载快捷键配置（组合键 + 启用/禁用），供设置面板渲染与全局监听使用
  try { await loadShortcuts(); } catch { state.shortcuts = defaultShortcuts(); }

  // 注册：本地 HTTP API 操作后由主进程通知刷新界面
  try { if (window.api.onApiRefresh) window.api.onApiRefresh(() => { refreshAll().catch(() => {}); }); } catch { /* 忽略 */ }

  // 主题与语言优先套用，保证首屏就是正确外观/文案
  try { if (cfg) applyConfigToUi(cfg); } catch { /* 默认值 */ }
  applyTheme((cfg && cfg.theme) || 'system');
  await loadLang((cfg && cfg.lang) || 'zh-CN');

  // 语言包加载完毕后，重新同步绑定标签（applyConfigToUi 可能在 I18N 就绪前执行，导致显示原始 key）
  if (cfg && cfg.binding) { syncBindingLabel(); renderBindingList(); }

  // 载入各绑定方式的导入数量限位器（手动 9999 / 英文键位顺序 24 / 流转顺序 12），套用到当前 count
  try {
    const limits = await window.api.bindingLimits();
    if (limits && typeof limits === 'object') state.bindingLimits = limits;
  } catch { /* 保留默认值 */ }
  applyBindingLimit();

  // 恢复「固定窗口」置顶状态（持久化于 config.yaml）
  if (cfg && typeof cfg.pinned === 'boolean') {
    try {
      const res = await window.api.toggleAlwaysOnTop({ pinned: cfg.pinned });
      $('#btn-pin').classList.toggle('pin-active', !!res.pinned);
    } catch { /* 忽略 */ }
  }

  // 载入手动绑定（跨批次持久化 + 全局默认，启动即恢复）
  try {
    state.batchBindings = (await window.api.loadBindings()) || {};
  } catch { state.batchBindings = {}; }

  try {
    // 恢复上次打开的数据批次（config.yaml 的 lastBatch）；丢失/异常时不加载，等待手动选择
    const lastBatch = cfg && cfg.lastBatch;
    await refreshBatches(lastBatch);
    if (state.batch) {
      // 已自动恢复批次 → 完成启动
      hintRevealEnabled = true;
      return;
    }
  } catch { /* fall through */ }

  // 完全没有任何数据批次时，不加载虚拟/缓存数据；仪表卡显示占位符「—」
  if (!state.batches.length) {
    renderList(); renderStats();
  }
  // 启动完成：此后出现的新提示才显现隐藏按钮（满足"启动默认隐藏"）
  hintRevealEnabled = true;
}

/**
 * 启动期配置完整性检测：扫描所有配置文件，发现异常时缓存并弹框；
 * 用户可一键「隔离并重载新的配置文件」（坏文件重命名隔离后重新初始化）。
 */
async function checkConfigIntegrity() {
  let issues = [];
  try {
    issues = (await window.api.configCheck()) || [];
  } catch (e) {
    console.warn('config check failed:', e);
    return; // 检测自身失败也不阻塞启动
  }
  // 语言包异常由加载器从内置表自动恢复（复制回本地），不参与「隔离」弹框
  issues = issues.filter((i) => i.kind !== 'lang');
  if (!issues.length) return; // 无异常：正常启动

  const action = await showConfigErrorDialog(issues);
  if (action === 'isolate') {
    try {
      const res = await window.api.configIsolate({ issues });
      const okN = (res || []).filter((r) => r.ok).length;
      const failN = (res || []).length - okN;
      if (okN) setStatusBar(t('msg.configIsolated', { n: okN }), 'ok');
      if (failN) setStatusBar(t('msg.configIsolateFail', { n: failN }), 'err');
    } catch (e) {
      setStatusBar(String(e.message || e), 'err');
    }
  }
}

/**
 * 配置异常提示框：列出所有异常配置文件的范围（相对路径 + 原因），
 * 提供「隔离并重载新的配置文件」按钮。resolve('isolate' | 'ignore')。
 */
function showConfigErrorDialog(issues) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    const box = document.createElement('div');
    box.className = 'dialog-box';

    const title = document.createElement('div');
    title.className = 'dialog-title';
    title.textContent = t('dialog.configError.title');

    const body = document.createElement('div');
    body.className = 'dialog-body';

    const desc = document.createElement('div');
    desc.textContent = t('dialog.configError.desc');
    body.appendChild(desc);

    const rangeLabel = document.createElement('div');
    rangeLabel.style.marginTop = '8px';
    rangeLabel.textContent = t('dialog.configError.range');
    body.appendChild(rangeLabel);

    const list = document.createElement('ul');
    list.className = 'config-error-list';
    for (const it of issues) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'ce-name';
      name.textContent = it.rel;
      const r = document.createElement('span');
      r.className = 'ce-reason';
      r.textContent = ' — ' + it.reason;
      li.appendChild(name);
      li.appendChild(r);
      list.appendChild(li);
    }
    body.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const btnIgnore = document.createElement('button');
    btnIgnore.className = 'dialog-btn-cancel';
    btnIgnore.textContent = t('dialog.configError.ignore');
    const btnIsolate = document.createElement('button');
    btnIsolate.className = 'dialog-btn-primary';
    btnIsolate.textContent = t('dialog.configError.isolate');

    const close = (val) => { overlay.remove(); resolve(val); };
    btnIgnore.addEventListener('click', () => close('ignore'));
    btnIsolate.addEventListener('click', () => close('isolate'));
    // 点击遮罩空白处 = 忽略并继续
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('ignore'); });

    actions.appendChild(btnIgnore);
    actions.appendChild(btnIsolate);
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
