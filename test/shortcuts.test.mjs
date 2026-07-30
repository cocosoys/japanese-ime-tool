import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { ShortcutsStore, SHORTCUT_ACTIONS } from '../src/store/shortcutsStore.js';

let pass = 0;
function ok(name) { pass++; console.log(`✓ ${name}`); }

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sc-'));
  try {
    const fp = path.join(tmp, 'shortcuts.json');
    const store = new ShortcutsStore({ filePath: fp });

    // 1) 缺失文件 → 回退默认（5 个动作齐全，默认启用）
    let sc = await store.load();
    assert(Object.keys(sc).length === SHORTCUT_ACTIONS.length, '默认应有 5 个动作');
    assert(sc.capture.combo === 'Alt+X' && sc.capture.enabled === true, 'capture 默认 Alt+X 启用');
    ok('缺失文件回退默认（5 动作齐全、默认启用）');

    // 2) 保存 + 读取 round-trip，含自定义组合键与禁用状态
    const custom = {
      capture: { combo: 'Ctrl+Alt+K', enabled: true },
      doImport: { combo: 'Alt+V', enabled: false },   // 禁用
      doClear: { combo: 'Alt+C', enabled: true },
      doUndo: { combo: 'Alt+Z', enabled: true },
      togglePhraseField: { combo: 'Alt+B', enabled: true },
    };
    await store.save(custom);
    const loaded = await store.load();
    assert(loaded.capture.combo === 'Ctrl+Alt+K', '组合键已保存');
    assert(loaded.doImport.enabled === false, '禁用状态已持久化');
    ok('保存/读取 round-trip（自定义组合键 + 禁用状态）');

    // 3) 损坏文件 → 回退默认
    await fs.writeFile(fp, '{ not json', 'utf8');
    const recovered = await store.load();
    assert(recovered.capture.combo === 'Alt+X', '损坏后回退默认');
    ok('损坏文件回退默认');

    // 4) save 规整：缺字段补默认、enabled 缺失视为 true
    await store.save({ capture: { combo: 'F5' } });
    const norm = await store.load();
    assert(norm.capture.combo === 'F5' && norm.capture.enabled === true, '部分字段补默认');
    ok('save 规整（缺字段补默认、enabled 缺失视为 true）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  console.log(`\n快捷键配置测试全部通过 ✅ (${pass} 项)`);
}
main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
