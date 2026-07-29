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
  batch: null,                 // 当前选中的批次目录名（如 2026-07-28_0937）
  used: new Set(),             // 已使用值集合（存「短语字段的值」，持久化到 used.json）
  lastImportInfo: null,        // 上一次导入信息（用于撤回）：{ usedKeysAdded: string[], backupPath?: string }
  lang: 'zh-CN',               // 界面语言
  theme: 'system',             // 主题：light / dark / system
  bindingLimits: { manual: 9999, manualGlobal: 9999, qwerty: 24, qwerFlow: 12 }, // 各绑定方式导入数量限位器（由 IPC 覆盖）
  batches: [],                 // 全部批次目录名
  batchUsage: {},              // { [batch]: { used, total } } 按当前短语字段统计的使用情况
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
  updateOrderValueVisibility();
}

/** 仅在「固定」模式显示候选位置数值输入框；「自动」时隐藏 */
function updateOrderValueVisibility() {
  const sel = $('#orderMode').value;
  const input = $('#orderValue');
  if (sel === 'fixed') input.classList.add('show');
  else input.classList.remove('show');
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

function persistUsed() {
  if (!state.batch) return Promise.resolve();
  return window.api.saveUsed({ batch: state.batch, used: [...state.used] }).catch(() => {});
}

function sortedView() {
  return [...state.entries].sort((a, b) => (isEntryUsed(a) ? 1 : 0) - (isEntryUsed(b) ? 1 : 0));
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

/** 渲染批次下拉列表项（含使用情况进度条 + 数字标注） */
function renderBatchList() {
  const list = $('#batch-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.batches.length) {
    list.appendChild(el('div', 'batch-item empty', t('list.empty')));
    return;
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
    // 绿色填充宽度 = 未使用占比；剩余部分由 bar 背景（红色=已使用）透出
    fill.style.width = unusedPct + '%';
    bar.appendChild(fill);   // 关键：将 fill 挂到 bar 内，绿色覆盖未使用部分

    // 数字标注：未用/总数
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
 * 显示导入预览弹窗（滚动列表，每条显示编码→短语映射）。
 * @param {Array<{code:string, word:string, index:number}>} items 预览条目
 * @returns {Promise<{confirmed:boolean, skip:boolean}>} confirmed=确认导入, skip=不再提醒
 */
function showImportPreview(items) {
  return new Promise((resolve) => {
    const overlay = $('#dialog-overlay');
    const title = $('#dialog-title');
    const body = $('#dialog-body');
    const actions = $('#dialog-actions');

    title.textContent = t('dialog.importPreview.title');
    title.style.color = '#1864ab';
    title.style.setProperty('::before', '"📋"');

    // 构建可滚动列表
    const listEl = document.createElement('div');
    listEl.className = 'preview-list';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'preview-item';
      const codeSpan = document.createElement('span');
      codeSpan.className = 'preview-code';
      codeSpan.textContent = it.code || '—';
      const arrow = document.createElement('span');
      arrow.className = 'preview-arrow';
      arrow.textContent = '→';
      const wordSpan = document.createElement('span');
      wordSpan.className = 'preview-word';
      wordSpan.textContent = it.word;
      const idxSpan = document.createElement('span');
      idxSpan.className = 'preview-idx';
      idxSpan.textContent = `第${it.index + 1}位`;
      row.appendChild(codeSpan);
      row.appendChild(idxSpan);
      row.appendChild(arrow);
      row.appendChild(wordSpan);
      listEl.appendChild(row);
    });
    body.innerHTML = '';
    body.appendChild(listEl);

    // "此后不再提醒" 勾选框
    const skipWrap = document.createElement('label');
    skipWrap.className = 'preview-skip-wrap';
    const skipCb = document.createElement('input');
    skipCb.type = 'checkbox';
    skipCb.id = 'preview-skip-cb';
    const skipLabel = document.createElement('span');
    skipLabel.textContent = t('dialog.importPreview.skip');
    skipWrap.appendChild(skipCb);
    skipWrap.appendChild(skipLabel);
    actions.innerHTML = '';
    actions.appendChild(skipWrap);

    const btnOk = document.createElement('button');
    btnOk.className = 'dialog-btn-primary';
    btnOk.textContent = t('dialog.importPreview.confirm');
    btnOk.addEventListener('click', () => { overlay.classList.add('hidden'); resolve({ confirmed: true, skip: skipCb.checked }); });
    const btnCancel = document.createElement('button');
    btnCancel.className = 'dialog-btn-cancel';
    btnCancel.textContent = t('dialog.importPreview.cancel');
    btnCancel.addEventListener('click', () => { overlay.classList.add('hidden'); resolve({ confirmed: false, skip: skipCb.checked }); });
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);

    overlay.classList.remove('hidden');
    overlay.onclick = (e) => {
      if (e.target === overlay) { overlay.classList.add('hidden'); resolve({ confirmed: false, skip: skipCb.checked }); }
    };
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
 */
function renderStats() {
  const fields = ['kanji', 'romaji', 'hiragana'];
  for (const field of fields) {
    const card = $(`.stat-card[data-field="${field}"]`);
    if (!card) continue;
    // 高亮当前短语字段对应的仪表卡（点击卡片可切换短语字段）
    card.classList.toggle('active', field === currentField());
    const valueEl = card.querySelector('.stat-card-value');
    const pctEl = card.querySelector('.stat-card-pct');
    const barFill = card.querySelector('.stat-card-bar-fill');
    const footerEl = card.querySelector('.stat-card-footer');

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
  if (!batches.length) {
    state.batch = null;
    $('#batch-label').textContent = '—';
    renderBatchList();
    renderStats();
    return false;
  }
  // 明确指定了批次（config.yaml 记录的 lastBatch 或抓取新建批次）且该批次仍存在
  if (selectBatch && batches.includes(selectBatch)) {
    state.batch = selectBatch;
    $('#batch-label').textContent = selectBatch;
    await loadBatchUsage();
    renderBatchList();
    await loadBatch(selectBatch);
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
  const { entries, used } = await window.api.loadBatch({ batch });
  state.batch = batch;
  state.entries = entries || [];
  state.used = new Set(used || []);
  // 别名仅内存、按需求不持久化，切批次清空；手动绑定(batchBindings)跨批次保留，不清空
  state.aliases = {};
  renderList(); renderStats();
  setStatusBar(t('msg.batchLoaded', { batch, n: state.entries.length }), 'ok');
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
      persistUsed();
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

async function doImport() {
  if (!state.entries.length) { setStatusBar(t('msg.noImport'), 'err'); return; }
  let count = Math.max(1, parseInt($('#count').value, 10) || 10);
  // 按绑定方式限位器钳制（手动 9999 / 英文键位顺序 24 / 流转顺序 12）
  const limit = currentLimit();
  if (count > limit) { count = limit; $('#count').value = count; persistConfig(); }

  const view = sortedView();
  const slice = view.slice(0, count);
  const usedInSlice = slice.filter((e) => isEntryUsed(e));

  if (usedInSlice.length > 0) {
    const unusedTotal = view.length - view.filter((e) => isEntryUsed(e)).length;
    if (unusedTotal > 0) {
      const ok = confirm(t('confirm.usedInSlice', {
        count, used: usedInSlice.length, adj: Math.min(count, unusedTotal),
      }));
      if (!ok) { setStatusBar(t('msg.cancelled')); return; }
      count = Math.min(count, unusedTotal);
      $('#count').value = count;
      persistConfig();
    } else {
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
        const qwertySeq = 'qwertyuiopasdfghjklzxcvb';
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

  // ── 自动模式：先检测候选位置冲突，让用户确认后再导入 ──
  if (config.orderMode === 'auto') {
    try {
      setStatusBar(t('msg.checkingConflict'));
      const resolveRes = await window.api.resolveOrders({ config, entries: view, aliases });
      if (resolveRes.adjustments && resolveRes.adjustments.length > 0) {
        const lines = resolveRes.adjustments.map((a) =>
          t('line.orderAdjust', { code: a.code, word: a.word, from: a.fromOrder, to: a.toOrder })
        ).join('\n');
        const ok = confirm(t('confirm.orderAdjust', { n: resolveRes.adjustments.length, lines }));
        if (!ok) { setStatusBar(t('msg.cancelled')); return; }
      }
      // 无冲突时静默继续
    } catch (e) {
      // 冲突检测失败不阻断导入，回退到固定模式行为
      setStatusBar(t('msg.conflictFail', { err: e.message }), 'err');
      config.orderMode = 'fixed';
    }
  }

  // ── 导入预览：展示每条编码→短语映射，用户确认后才实际导入 ──
  const pField = $('#phraseField').value;
  const bindingVal = $('#binding').value;
  const previewItems = view.slice(0, count).map((e, i) => {
    let code = lockedBindings[i] || '';
    // 非手动模式：显示该绑定方式实际分配的键位编码
    if (!code && bindingVal !== 'manual' && bindingVal !== 'manualGlobal') {
      if (bindingVal === 'qwerty') code = 'qwertyuiopasdfghjklzxcvb'[i] || '';
      else if (bindingVal === 'qwerFlow') code = 'qwerasdfzxcv'[i] || '';
    }
    return { code: code || '—', word: e[pField] || e.kanji || e.raw || '?', index: i };
  });

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

    // 根据重载结果显示不同状态信息
    const files = [res.eudpTarget, res.udlTarget, res.legacyTarget].filter(Boolean).join(' + ');
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusBar(t('msg.importOk', { n: res.records.length, files }), 'ok');
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusBar(t('msg.importPartial', { n: res.records.length, files, method }), 'err');
    }
  } catch (e) {
    setStatusBar(t('msg.importFail', { err: e.message || e }), 'err');
  } finally {
    btnImp.disabled = false;
  }
}

// ─── 一键清除 ───

async function doClear() {
  const ok = confirm(t('confirm.clear'));
  if (!ok) return;

  const btn = $('#btn-clear');
  btn.disabled = true;
  setStatusBar(t('msg.clearing'));
  try {
    const res = await window.api.clearIme();
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusBar(t('msg.clearOk', { n: res.originalCount, target: res.target }), 'ok');
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusBar(t('msg.clearPartial', { n: res.originalCount, method }), 'err');
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
      setStatusBar(t('msg.undoOk', { target: res.target }), 'ok');
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusBar(t('msg.undoPartial', { target: res.target, method }), 'err');
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
}

// 点击面板外部时自动收起
document.addEventListener('mousedown', (e) => {
  const panel = $('#settings-panel');
  if (!panel.classList.contains('open')) return;
  if (panel.contains(e.target) || e.target.closest('#btn-settings')) return;
  toggleSettings(false);
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

// ─── 事件绑定 ───

$('#btn-auto').addEventListener('click', autoFetch);
$('#btn-import').addEventListener('click', doImport);
$('#btn-clear').addEventListener('click', doClear);
$('#btn-undo').addEventListener('click', doUndo);
$('#btn-close').addEventListener('click', () => window.api.close());
$('#btn-min').addEventListener('click', () => window.api.minimize());
$('#btn-settings').addEventListener('click', () => toggleSettings());
$('#btn-refresh').addEventListener('click', refreshAll);

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
$('#batch-btn').addEventListener('click', () => {
  if ($('#batch-list').classList.contains('hidden')) { renderBatchList(); openBatchList(); }
  else closeBatchList();
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

// 全局快捷键：Alt+X 抓取 / Alt+V 一键导入 / Alt+C 一键清除 / Alt+Z 撤回 / Alt+B 切换短语字段
document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'x') { e.preventDefault(); autoFetch(); }
  else if (k === 'v') { e.preventDefault(); doImport(); }
  else if (k === 'c') { e.preventDefault(); doClear(); }
  else if (k === 'z') { e.preventDefault(); doUndo(); }
  else if (k === 'b') { e.preventDefault(); togglePhraseField(); }
});

['#gender', '#popularity', '#phraseField', '#binding', '#orderMode'].forEach((sel) => {
  $(sel).addEventListener('change', persistConfig);
});
// 切换候选位置模式时同步显示/隐藏固定值输入框
$('#orderMode').addEventListener('change', () => { updateOrderValueVisibility(); });
$('#orderValue').addEventListener('input', persistConfig);
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

  // 先填充语言下拉，保证 applyConfigToUi 能正确选中当前语言
  await populateLangSelect();

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

  // 完全没有任何数据批次时，才尝试加载缓存数据作为兜底
  if (!state.batches.length) {
    const data = await window.api.cached();
    if (data && data.length) {
      state.entries = data;
      renderList(); renderStats();
      setStatusBar(t('msg.cacheLoaded', { n: data.length }), 'ok');
    }
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
