import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { TempJsonStore } from '../src/store/tempJsonStore.js';
import { BindingsStore } from '../src/store/bindingsStore.js';

let pass = 0;
function ok(name) { pass++; console.log(`✓ ${name}`); }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-'));
  try {
    const base = path.join(tmp, 'names_data');
    const store = new TempJsonStore({ baseDir: base });
    const bstore = new BindingsStore({ filePath: path.join(tmp, 'bindings.json') });

    // 创建两个批次目录 + name.json
    const batchA = '2026-07-28_1000', batchB = '2026-07-28_1100';
    for (const b of [batchA, batchB]) {
      const d = path.join(base, b);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, 'name.json'),
        JSON.stringify([{ kanji: '花', romaji: 'hana', hiragana: 'はな' }]), 'utf8');
    }
    // 为两个批次写入绑定
    await bstore.saveBatch(batchA, { '0': { identifier: 'a', locked: true } });
    await bstore.saveBatch(batchB, { '0': { identifier: 'b', locked: true } });

    // 删除 batchA：目录 + 级联绑定（与 main.js batch-delete IPC 逻辑一致）
    await store.deleteBatch(batchA);       // 1) 删除批次目录
    await bstore.saveBatch(batchA, {});    // 2) 级联删除该批次的绑定键
    assert(!(await exists(path.join(base, batchA))), 'batchA 目录应被删除');
    const binds = await bstore.load();
    assert(!binds[batchA], 'batchA 绑定应被级联删除');
    assert(binds[batchB] && binds[batchB]['0'].identifier === 'b', 'batchB 绑定应保留');
    ok('deleteBatch 删除目录 + 级联删除该批次绑定（其余批次不受影响）');

    // 删除不存在的批次不报错
    await store.deleteBatch('no-such-batch');
    ok('删除不存在批次不报错');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  console.log(`\n批次删除（级联绑定）测试全部通过 ✅ (${pass} 项)`);
}
main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
