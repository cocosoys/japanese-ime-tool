// 渲染进程：UI 状态与交互。所有耗时操作都走 window.api（IPC -> 主进程服务层）。
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

const state = {
  entries: [],                 // NameEntry JSON 数组
  bindings: {},                // {index: 自定义编码}
  locked: new Set(),           // 锁定下标（不再被策略自动填充）
  aliases: {},                 // {index: [code,...]}
};

const FIELD_LABEL = { kanji: '汉字', romaji: '罗马音', hiragana: '平假名', cnSimplified: '简中' };

function setStatus(msg, kind = '') {
  const s = $('#status');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

// ─── 配置持久化（./data/config.yaml） ───

// 配置字段 ↔ UI 控件的映射
const CONFIG_FIELDS = ['gender', 'popularity', 'phraseField', 'binding', 'count'];

function readConfigFromUi() {
  return {
    gender: $('#gender').value,
    popularity: $('#popularity').value,
    phraseField: $('#phraseField').value,
    binding: $('#binding').value,
    count: Math.max(1, parseInt($('#count').value, 10) || 10),
  };
}

function applyConfigToUi(cfg) {
  if (!cfg) return;
  if (cfg.gender) $('#gender').value = cfg.gender;
  if (cfg.popularity) $('#popularity').value = cfg.popularity;
  if (cfg.phraseField) $('#phraseField').value = cfg.phraseField;
  if (cfg.binding) $('#binding').value = cfg.binding;
  if (cfg.count) $('#count').value = cfg.count;
}

let saveTimer = null;
function persistConfig() {
  // 轻微防抖，避免连续变更时频繁写盘
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveConfig(readConfigFromUi()).catch(() => {});
  }, 300);
}

// 构建与主进程 auto-cf 隐藏窗口一致的目标 URL（带上 UI 当前筛选条件）
function buildTargetUrl() {
  const gender = $('#gender').value;
  const popularity = $('#popularity').value;
  return `https://www.namechef.co/cn/name-generator/japanese/?gender=${gender}&last_name_type=random&last_name=&popularity%5B%5D=${popularity}`;
}

// ⚡抓取：隐藏 Chromium 窗口自动过 Cloudflare → 取 cookie+HTML → 解析入库
async function autoFetch() {
  const btn = $('#btn-auto');
  btn.disabled = true;
  setStatus('正在通过 Cloudflare 质询…（若弹出验证窗口请点一下）');
  let fileInfo = '';
  try {
    const { cookie, html } = await window.api.autoCf({ url: buildTargetUrl() });

    // cookie 自动回填输入框（fetch 兜底时复用）
    if (cookie) $('#cookie').value = cookie;

    if (html && html.length > 500) {
      // 首选：直接解析质询窗口里已渲染好的 HTML（不再发网络请求，最稳）
      setStatus('已通过质询，解析页面中…');
      const result = await window.api.collectFromHtml({ html });
      state.entries = result.entries || result;  // 兼容新旧格式
      if (result.jsonPath) fileInfo = ` | JSON → ${result.jsonPath}`;
    } else {
      // 兜底：拿 cookie 走 fetch 抓取
      setStatus('已获取 Cookie，抓取中…');
      state.entries = await window.api.collect({
        cookie,
        gender: $('#gender').value,
        popularity: $('#popularity').value,
      });
    }

    state.bindings = {}; state.locked.clear(); state.aliases = {};
    renderList();
    setStatus(`✅ 抓取成功：${state.entries.length} 个名字，已保存${fileInfo}`, 'ok');
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
  state.entries.forEach((e, i) => {
    const item = el('div', 'item');

    const name = el('div', 'name');
    name.appendChild(el('span', 'kanji', e.kanji || e.raw || '?'));
    const sub = [e.romaji, e.hiragana && '(' + e.hiragana + ')'].filter(Boolean).join(' ');
    if (sub) name.appendChild(el('span', 'sub', sub));
    item.appendChild(name);

    const code = el('input', 'code');
    code.placeholder = '绑定';
    code.value = state.bindings[i] ?? '';
    code.addEventListener('input', () => { state.bindings[i] = code.value.trim(); });
    item.appendChild(code);

    const lock = el('button', 'lock', state.locked.has(i) ? '🔒' : '🔓');
    lock.title = '锁定绑定（不被自动填充覆盖）';
    lock.classList.toggle('on', state.locked.has(i));
    lock.addEventListener('click', () => {
      if (state.locked.has(i)) { state.locked.delete(i); delete state.bindings[i]; }
      else { state.locked.add(i); state.bindings[i] = code.value.trim(); }
      renderList();
    });
    item.appendChild(lock);

    const add = el('button', 'add', '＋');
    add.title = '增加一条别名绑定（同一名字额外编码）';
    add.addEventListener('click', () => {
      (state.aliases[i] ||= []).push('');
      renderList();
      // 聚焦新出现的别名输入框
      const inputs = list.querySelectorAll('.alias input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    item.appendChild(add);

    list.appendChild(item);

    // 别名绑定行
    (state.aliases[i] || []).forEach((al, ai) => {
      const a = el('div', 'alias');
      const ain = el('input');
      ain.placeholder = '别名' + (ai + 1);
      ain.value = al;
      ain.addEventListener('input', () => { state.aliases[i][ai] = ain.value.trim(); });
      a.appendChild(ain);
      const del = el('button', null, '×');
      del.addEventListener('click', () => { state.aliases[i].splice(ai, 1); renderList(); });
      a.appendChild(del);
      list.appendChild(a);
    });
  });
}

async function doImport() {
  if (!state.entries.length) { setStatus('没有可导入的名字', 'err'); return; }
  const config = {
    count: Math.max(1, parseInt($('#count').value, 10) || 10),
    phraseField: $('#phraseField').value,
    bindingStrategy: $('#binding').value,
    lockedBindings: { ...state.bindings },
  };
  $('#btn-import').disabled = true;
  setStatus('生成 .dat 并写入输入法…');
  try {
    const res = await window.api.import({ config, entries: state.entries, aliases: state.aliases });
    setStatus(`已导入 ${res.records.length} 条 -> ${res.target}`, 'ok');
  } catch (e) {
    setStatus('导入失败：' + (e.message || e), 'err');
  } finally {
    $('#btn-import').disabled = false;
  }
}

// 事件绑定
$('#btn-auto').addEventListener('click', autoFetch);
$('#btn-import').addEventListener('click', doImport);
$('#btn-close').addEventListener('click', () => window.api.close());
$('#btn-min').addEventListener('click', () => window.api.minimize());

// 配置项变更 → 自动保存到 ./data/config.yaml
['#gender', '#popularity', '#phraseField', '#binding'].forEach((sel) => {
  $(sel).addEventListener('change', persistConfig);
});
$('#count').addEventListener('input', persistConfig);

// 启动：先恢复配置，再加载缓存数据
(async () => {
  try {
    const cfg = await window.api.loadConfig();
    applyConfigToUi(cfg);
  } catch { /* 用默认值 */ }

  const data = await window.api.cached();
  if (data && data.length) {
    state.entries = data;
    renderList();
    setStatus(`已加载缓存 ${data.length} 条`, 'ok');
  }
})();
