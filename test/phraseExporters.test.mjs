// 单条短语导入/删除所依赖的导出器解析+重建 round-trip，以及 ImportService 的单条增删逻辑
import { MspyUdlExporter } from '../src/implementations/exporter/MspyUdlExporter.js';
import { MsPinyinDatExporter } from '../src/implementations/exporter/MsPinyinDatExporter.js';
import { MschxudpExporter } from '../src/implementations/exporter/MschxudpExporter.js';
import { ImportService } from '../src/services/ImportService.js';
import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-phrase-'));
const eudpPath = path.join(tmpDir, 'ChsPinyinEUDPv1.lex');
const udlPath = path.join(tmpDir, 'ChsPinyinUDL.dat');
const machPath = path.join(tmpDir, 'ChsUserPhrase.dat');

try {
  // ── UDL 解析 + 重建 round-trip ──
  const udl = new MspyUdlExporter();
  const udlBuf = await udl.export([{ code: 'q', word: '田中' }, { code: 'w', word: '佐藤' }], { filePath: udlPath });
  fs.writeFileSync(udlPath, udlBuf);
  const udlParsed = await udl.parseEntriesWithCode(udlPath);
  assert.strictEqual(udlParsed.length, 2);
  assert.strictEqual(udlParsed[0].code, 'q');
  assert.strictEqual(udlParsed[0].word, '田中');
  ok('UDL：解析含触发码 (code+word) 正确');

  // UDL 删除单条后重建，仅剩佐藤
  const udlKept = udlParsed.filter((e) => e.word !== '田中').map((e) => e.raw);
  const udlBuf2 = udl.buildFromRaws(udlKept);
  fs.writeFileSync(udlPath, udlBuf2);
  const udlParsed2 = await udl.parseEntriesWithCode(udlPath);
  assert.strictEqual(udlParsed2.length, 1);
  assert.strictEqual(udlParsed2[0].word, '佐藤');
  ok('UDL：删除单条后重建仅剩剩余词条');

  // ── machxudp 解析 + 重建 round-trip ──
  const mach = new MsPinyinDatExporter();
  const machBuf = mach.export([{ code: 'q', word: '田中', order: 1 }, { code: 'w', word: '佐藤', order: 2 }]);
  fs.writeFileSync(machPath, machBuf);
  const machParsed = await mach.parse(machPath);
  assert.strictEqual(machParsed.length, 2);
  assert.strictEqual(machParsed[0].code, 'q');
  assert.strictEqual(machParsed[0].word, '田中');
  assert.strictEqual(machParsed[0].candidate, 1);
  ok('machxudp：解析 (code+word+order) 正确');

  const machKept = machParsed.filter((e) => e.word !== '田中').map((e) => ({ code: e.code, word: e.word, order: e.candidate }));
  const machBuf2 = mach.export(machKept);
  fs.writeFileSync(machPath, machBuf2);
  const machParsed2 = await mach.parse(machPath);
  assert.strictEqual(machParsed2.length, 1);
  assert.strictEqual(machParsed2[0].word, '佐藤');
  ok('machxudp：删除单条后重建仅剩剩余词条');

  // ── ImportService 单条增删（mock importer 捕获三层 buffer）──
  const captured = [];
  const mockImporter = {
    eudpPath, udlPath, targetPath: udlPath, legacyPath: machPath,
    import: async (bufs) => {
      captured.push(bufs);
      // 模拟真实 importer 将三层 buffer 写回磁盘，使后续从文件回读断言有意义
      if (bufs.mschxudpBuffer) await fs.promises.writeFile(eudpPath, bufs.mschxudpBuffer);
      if (bufs.udlBuffer) await fs.promises.writeFile(udlPath, bufs.udlBuffer);
      if (bufs.machxudpBuffer) await fs.promises.writeFile(mockImporter.legacyPath, bufs.machxudpBuffer);
      return { target: eudpPath, reloaded: { killedChsIME: true } };
    },
  };
  const svc = new ImportService({ importer: mockImporter });

  // 预置 EUDP/UDl/mach 各含 A、B 两条
  // 注意：UDL 导出器 export 总是合并现有文件，故先清掉 round-trip 残留（佐藤），确保预置恰好为 A,B
  const mschx = new MschxudpExporter();
  fs.rmSync(udlPath, { force: true });
  await fs.promises.writeFile(eudpPath, await mschx.export([{ code: 'a', word: 'A' }, { code: 'b', word: 'B' }], { filePath: eudpPath, merge: false }));
  await fs.promises.writeFile(udlPath, await udl.export([{ code: 'a', word: 'A' }, { code: 'b', word: 'B' }], { filePath: udlPath }));
  await fs.promises.writeFile(machPath, mach.export([{ code: 'a', word: 'A', order: 1 }, { code: 'b', word: 'B', order: 2 }]));

  // 删除单条 A → 三层均只剩 B
  await svc.deletePhrase({ code: 'a', word: 'A' });
  assert.ok(captured.length >= 1);
  const last = captured[captured.length - 1];
  const delEudp = mschx._parse(last.mschxudpBuffer);
  assert.strictEqual(delEudp.length, 1);
  assert.strictEqual(delEudp[0].word, 'B');
  ok('ImportService.deletePhrase：EUDPv1.lex 仅剩 B');

  const delUdl = await udl.parseEntriesWithCode(udlPath); // 重新从文件读（deletePhrase 已写回）
  assert.strictEqual(delUdl.length, 1);
  assert.strictEqual(delUdl[0].word, 'B');
  ok('ImportService.deletePhrase：UDL 仅剩 B');

  const delMach = await mach.parse(machPath);
  assert.strictEqual(delMach.length, 1);
  assert.strictEqual(delMach[0].word, 'B');
  ok('ImportService.deletePhrase：machxudp 仅剩 B');

  // 新增单条 C → 三层各含 B、C（C 追加）
  await svc.addPhrase({ code: 'c', word: 'C', order: 1 });
  const addEudp = mschx._parse((await fs.promises.readFile(eudpPath)));
  assert.ok(addEudp.some((e) => e.word === 'C'));
  assert.ok(addEudp.some((e) => e.word === 'B'));
  ok('ImportService.addPhrase：EUDPv1.lex 追加 C 并保留 B');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`单条短语导出器与增删测试全部通过 ✅ (${passed} 项)`);
} catch (e) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  console.error('单条短语测试失败 ❌:', e.message);
  process.exit(1);
}
