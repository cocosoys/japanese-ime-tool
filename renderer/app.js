// 渲染进程：UI 状态与交互。所有耗时操作都走 window.api（IPC -> 主进程服务层）。
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

const state = {
  entries: [],                 // NameEntry JSON 数组（原始顺序，与 name.json 一致）
  bindings: {},                // {显示行号: 自定义编码} —— 按「行」记录，排序变化后绑定固定在原行
  locked: new Set(),           // 锁定的显示行号（锁定后该行绑定不随名称排序变化）
  aliases: {},                 // {显示行号: [code,...]}
  batch: null,                 // 当前选中的批次目录名（如 2026-07-28_0937）
  used: new Set(),             // 已使用值集合（存「短语字段的值」，持久化到 used.json）
  lastImportInfo: null,        // 上一次导入信息（用于撤回）：{ usedKeysAdded: string[], backupPath?: string }
};

const FIELD_LABEL = { kanji: '汉字', romaji: '罗马音', hiragana: '平假名', cnSimplified: '简中' };

// ─── 统一状态输出：所有信息 → 底部状态栏 ───
// 顶部区域仅保留抓取进度提示（短暂），最终结果一律写到底部

function setStatus(msg, kind = '') {
  // 顶部显示简短进度（3秒后自动淡出）
  const s = $('#status-top');
  s.textContent = msg;
  s.className = 'status-top' + (kind ? ' ' + kind : '');
  s.style.opacity = '1';
  // 同时写到底部栏（底部是持久输出）
  setStatusBar(msg, kind);
}

/** 底部状态栏 —— 全局唯一的信息输出终端 */
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
  if (cfg.binding) $('#binding').value = cfg.binding;
  if (cfg.count) $('#count').value = cfg.count;
  if (cfg.orderMode) $('#orderMode').value = cfg.orderMode;
  if (cfg.orderValue) $('#orderValue').value = cfg.orderValue;
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

// ─── 数据统计面板：三张仪表卡 ───

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
      ? `未用 ${unused} / 已用 ${used} / 共 ${total}`
      : '无数据';
  }
}

// ─── 批次管理 ───

async function refreshBatches(selectBatch) {
  const batches = await window.api.batches();
  const sel = $('#batch');
  sel.innerHTML = '';
  batches.forEach((b) => {
    const o = document.createElement('option');
    o.value = b; o.textContent = b;
    sel.appendChild(o);
  });
  if (!batches.length) { renderStats(); return false; }
  const target = selectBatch && batches.includes(selectBatch) ? selectBatch : batches[0];
  sel.value = target;
  await loadBatch(target);
  return true;
}

async function loadBatch(batch) {
  const { entries, used } = await window.api.loadBatch({ batch });
  state.batch = batch;
  state.entries = entries || [];
  state.used = new Set(used || []);
  state.bindings = {}; state.locked.clear(); state.aliases = {};
  renderList(); renderStats();
  setStatusBar(`已加载批次 ${batch}：${state.entries.length} 条`, 'ok');
}

function buildTargetUrl() {
  const g = $('#gender').value, p = $('#popularity').value;
  return `https://www.namechef.co/cn/name-generator/japanese/?gender=${g}&last_name_type=random&last_name=&popularity%5B%5D=${p}`;
}

// ⚡抓取
async function autoFetch() {
  const btn = $('#btn-auto');
  btn.disabled = true;
  setStatus('正在通过 Cloudflare 质询…（若弹出验证窗口请点一下）');
  let fileInfo = '';
  try {
    const { cookie, html } = await window.api.autoCf({ url: buildTargetUrl() });

    if (html && html.length > 500) {
      setStatus('已通过质询，解析页面中…');
      const result = await window.api.collectFromHtml({ html });
      if (result.jsonPath) fileInfo = ` | JSON → ${result.jsonPath}`;
      await refreshBatches(result.batch);
      setStatusBar(`✅ 抓取成功：${state.entries.length} 个名字，已保存${fileInfo}`, 'ok');
    } else {
      setStatus('已获取 Cookie，抓取中…');
      state.entries = await window.api.collect({
        cookie, gender: $('#gender').value, popularity: $('#popularity').value,
      });
      state.bindings = {}; state.locked.clear(); state.aliases = {};
      state.used = new Set();
      renderList(); renderStats();
      await refreshBatches();
      setStatusBar(`✅ 抓取成功：${state.entries.length} 个名字，已保存`, 'ok');
    }
  } catch (e) {
    setStatus('抓取失败：' + (e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  if (!state.entries.length) {
    list.appendChild(el('div', 'empty', '暂无数据，点「⚡抓取」一键获取'));
    return;
  }
  const isManual = $('#binding').value === 'manual';
  const field = currentField();
  const view = sortedView();

  view.forEach((e, row) => {
    const item = el('div', 'item');
    const key = usedKey(e);
    const isUsed = state.used.has(key);
    if (isUsed) item.classList.add('dim');

    // 小灯
    const light = el('span', 'light ' + (isUsed ? 'used' : 'unused'));
    light.title = isUsed ? '已使用（点击标记为未使用）' : '未使用（点击标记为已使用）';
    light.dataset.tip = isUsed ? '该名字已使用（点击标记为未使用）' : '该名字未使用（点击标记为已使用）';
    light.addEventListener('click', () => {
      if (state.used.has(key)) state.used.delete(key);
      else state.used.add(key);
      persistUsed();
      renderList(); renderStats();
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
          setStatusBar(`已复制：${text}`, 'ok');
        } catch {
          setStatusBar(`复制失败：${text}`, 'err');
        }
      });
      name.appendChild(line);
    };
    addLine(e.kanji || e.raw || '?', 'kanji', 'kanji');
    addLine(e.romaji, 'romaji', 'sub');
    addLine(e.hiragana, 'hiragana', 'sub');
    item.appendChild(name);

    // 绑定输入框 + 锁定（仅手动模式）
    if (isManual) {
      const code = el('input', 'code');
      code.placeholder = '绑定';
      code.value = state.bindings[row] ?? '';
      code.addEventListener('input', () => { state.bindings[row] = code.value.trim(); });
      item.appendChild(code);

      const lock = el('button', 'lock', state.locked.has(row) ? '🔒' : '🔓');
      lock.title = '锁定本行绑定';
      lock.dataset.tip = '锁定本行绑定，排序变化后该编码保持不动';
      lock.classList.toggle('on', state.locked.has(row));
      lock.addEventListener('click', () => {
        if (state.locked.has(row)) { state.locked.delete(row); delete state.bindings[row]; }
        else { state.locked.add(row); state.bindings[row] = code.value.trim(); }
        renderList();
      });
      item.appendChild(lock);
    }

    const add = el('button', 'add', '＋');
    add.title = '增加别名绑定';
    add.dataset.tip = '为当前名字增加一个别名绑定（另一个编码指向同一短语）';
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
      ain.placeholder = '别名' + (ai + 1);
      ain.value = al;
      ain.dataset.tip = '输入别名编码（如该名字的另一个罗马音）';
      ain.addEventListener('input', () => { state.aliases[row][ai] = ain.value.trim(); });
      a.appendChild(ain);
      const del = el('button', null, '×');
      del.title = '删除此别名';
      del.dataset.tip = '删除此别名绑定';
      del.addEventListener('click', () => { state.aliases[row].splice(ai, 1); renderList(); });
      a.appendChild(del);
      list.appendChild(a);
    });
  });
}

// ─── 一键导入 ───

async function doImport() {
  if (!state.entries.length) { setStatusBar('没有可导入的名字', 'err'); return; }
  let count = Math.max(1, parseInt($('#count').value, 10) || 10);

  const view = sortedView();
  const slice = view.slice(0, count);
  const usedInSlice = slice.filter((e) => isEntryUsed(e));

  if (usedInSlice.length > 0) {
    const unusedTotal = view.length - view.filter((e) => isEntryUsed(e)).length;
    if (unusedTotal > 0) {
      const ok = confirm(
        `即将导入的 ${count} 条中包含 ${usedInSlice.length} 条已使用名称。\n\n` +
        `点「确定」自动将导入数量调整为 ${Math.min(count, unusedTotal)}（仅导入未使用名称）并继续；\n` +
        `点「取消」中止本次导入。`
      );
      if (!ok) { setStatusBar('已取消导入'); return; }
      count = Math.min(count, unusedTotal);
      $('#count').value = count;
      persistConfig();
    } else {
      const ok = confirm(`当前批次名称已全部使用。\n\n是否仍按原数量导入前 ${count} 条已使用名称？`);
      if (!ok) { setStatusBar('已取消导入'); return; }
    }
  }

  const config = {
    count, phraseField: $('#phraseField').value,
    bindingStrategy: $('#binding').value,
    lockedBindings: { ...state.bindings },
    orderMode: $('#orderMode').value,
    orderValue: Math.max(1, parseInt($('#orderValue').value, 10) || 1),
  };

  // ── 自动模式：先检测候选位置冲突，让用户确认后再导入 ──
  if (config.orderMode === 'auto') {
    try {
      setStatusBar('正在检测候选位置冲突…');
      const resolveRes = await window.api.resolveOrders({ config, entries: view, aliases: state.aliases });
      if (resolveRes.adjustments && resolveRes.adjustments.length > 0) {
        const lines = resolveRes.adjustments.map((a) =>
          `  拼音「${a.code}」→ 短语「${a.word}」：位置 ${a.fromOrder} → ${a.toOrder}`
        ).join('\n');
        const ok = confirm(
          `检测到 ${resolveRes.adjustments.length} 处候选位置冲突，将自动调整：\n\n` +
          lines +
          '\n\n点「确定」按调整后的位置导入；点「取消」中止。'
        );
        if (!ok) { setStatusBar('已取消导入'); return; }
      }
      // 无冲突时静默继续
    } catch (e) {
      // 冲突检测失败不阻断导入，回退到固定模式行为
      setStatusBar(`⚠️ 冲突检测失败（${e.message}），将以固定位置=1 导入`, 'err');
      config.orderMode = 'fixed';
    }
  }

  const btnImp = $('#btn-import'), btnUndo = $('#btn-undo');
  btnImp.disabled = true;
  setStatusBar('生成 .dat 并写入输入法…');
  try {
    const keysToAdd = view.slice(0, count).map((e) => usedKey(e));
    const res = await window.api.import({ config, entries: view, aliases: state.aliases });

    view.slice(0, count).forEach((e) => state.used.add(usedKey(e)));
    await persistUsed();
    renderList(); renderStats();

    state.lastImportInfo = { usedKeysAdded: keysToAdd, backupPath: res.backupPath, backups: res.backups };
    btnUndo.disabled = false;

    // 根据重载结果显示不同状态信息
    const files = [res.eudpTarget, res.udlTarget, res.legacyTarget].filter(Boolean).join(' + ');
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusBar(`已导入 ${res.records.length} 条 → ${files} | IME 已重载`, 'ok');
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusBar(
        `已导入 ${res.records.length} 条（文件已写入）→ ${files}` +
        ` | ⚠️ IME 未完全重载（${method}），请确认 UAC 弹窗或重启输入法`,
        'err'
      );
    }
  } catch (e) {
    setStatusBar('导入失败：' + (e.message || e), 'err');
  } finally {
    btnImp.disabled = false;
  }
}

// ─── 一键清除 ───

async function doClear() {
  const ok = confirm('确定要清除所有用户自定义短语吗？\n\n此操作将清空微软拼音词库中的全部自定义词条！');
  if (!ok) return;

  const btn = $('#btn-clear');
  btn.disabled = true;
  setStatusBar('正在清除所有自定义短语…');
  try {
    const res = await window.api.clearIme();
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusBar(`已清除所有自定义短语（原 ${res.originalCount} 条）→ ${res.target} | IME 已重载`, 'ok');
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusBar(
        `已清除所有自定义短语（原 ${res.originalCount} 条，文件已写入）` +
        ` | ⚠️ IME 未完全重载（${method}），请确认 UAC 弹窗或重启输入法`,
        'err'
      );
    }
    state.lastImportInfo = { usedKeysAdded: [], backupPath: res.backupPath, backups: res.backups, wasClear: true };
    $('#btn-undo').disabled = false;
  } catch (e) {
    setStatusBar('清除失败：' + (e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ─── 撤回 ───

async function doUndo() {
  if (!state.lastImportInfo) { setStatusBar('无可撤回的操作'); return; }

  const info = state.lastImportInfo;
  const confirmMsg = info.wasClear
    ? '确定要撤回上次的「一键清除」吗？\n\n将恢复清除前的词库备份。'
    : `确定要撤回上次的导入吗？\n\n将移除本次导入的 ${info.usedKeysAdded.length} 条已使用标记，并恢复词库备份。`;
  if (!confirm(confirmMsg)) return;

  const btn = $('#btn-undo');
  btn.disabled = true;
  setStatusBar('正在撤回…');
  try {
    const res = await window.api.undoIme({ backupPath: info.backupPath, backups: info.backups });

    if (!info.wasClear && info.usedKeysAdded) {
      for (const k of info.usedKeysAdded) state.used.delete(k);
      await persistUsed();
    }

    state.lastImportInfo = null;
    renderList(); renderStats();
    if (res.reloaded && res.reloaded.killedChsIME) {
      setStatusBar(`已撤回 → ${res.target} | IME 已重载`, 'ok');
    } else {
      const method = res.reloaded?.method || 'unknown';
      setStatusBar(`已撤回（文件已恢复）→ ${res.target} | ⚠️ IME 未完全重载（${method}），请确认 UAC 弹窗或重启输入法`, 'err');
    }
  } catch (e) {
    setStatusBar('撤回失败：' + (e.message || e), 'err');
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

// 固定到窗口最前面（切换 alwaysOnTop）
$('#btn-pin').addEventListener('click', async () => {
  try {
    const res = await window.api.toggleAlwaysOnTop();
    $('#btn-pin').classList.toggle('pin-active', !!res.pinned);
    setStatusBar(res.pinned ? '已固定到窗口最前面' : '已取消固定（不再置顶）', 'ok');
  } catch {
    setStatusBar('切换置顶状态失败', 'err');
  }
});

// 隐藏提示栏
$('#btn-hide-status').addEventListener('click', () => {
  $('.status-bar-wrap').classList.add('hidden');
  $('#btn-hide-status').classList.remove('visible');
});

$('#batch').addEventListener('change', (e) => loadBatch(e.target.value));

['#gender', '#popularity', '#phraseField', '#binding', '#orderMode'].forEach((sel) => {
  $(sel).addEventListener('change', persistConfig);
});
// 切换候选位置模式时同步显示/隐藏固定值输入框
$('#orderMode').addEventListener('change', () => { updateOrderValueVisibility(); });
$('#orderValue').addEventListener('input', persistConfig);
$('#binding').addEventListener('change', renderList);
$('#phraseField').addEventListener('change', () => { renderList(); renderStats(); });
$('#count').addEventListener('input', persistConfig);

// ─── 新手引导提示气泡 ───
// 悬停任意带 [data-tip] 的控件时，在鼠标旁显示其作用说明。
function initTooltips() {
  const tip = el('div', 'tooltip');
  tip.id = 'tooltip';
  document.body.appendChild(tip);
  let tipTarget = null;

  const show = (target) => {
    const text = target.getAttribute('data-tip') || '';
    if (!text) { tip.classList.remove('show'); return; }
    tip.textContent = text;
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
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t !== tipTarget) { tipTarget = t; show(t); }
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t === tipTarget) { tipTarget = null; tip.classList.remove('show'); }
  });
  document.addEventListener('mousemove', (e) => {
    if (tipTarget) position(e.clientX, e.clientY);
  });
}

// 启动
(async () => {
  initTooltips();
  try {
    const cfg = await window.api.loadConfig();
    applyConfigToUi(cfg);
  } catch { /* 默认值 */ }

  try {
    const ok = await refreshBatches();
    if (ok) {
      // 启动完成：此后出现的新提示才显现隐藏按钮（满足"启动默认隐藏"）
      hintRevealEnabled = true;
      return;
    }
  } catch { /* fall through */ }

  const data = await window.api.cached();
  if (data && data.length) {
    state.entries = data;
    renderList(); renderStats();
    setStatusBar(`已加载缓存 ${data.length} 条`, 'ok');
  }
  // 启动完成：此后出现的新提示才显现隐藏按钮（满足"启动默认隐藏"）
  hintRevealEnabled = true;
})();
