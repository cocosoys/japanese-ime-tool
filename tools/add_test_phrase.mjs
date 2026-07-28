// 向真实的 ChsPinyinEUDPv1.lex 添加一条测试短语（合并模式，保留现有词条），用于真机验证一键导入链路。
// 用法: node tools/add_test_phrase.mjs [--no-reload]
import { MschxudpExporter } from '../src/implementations/exporter/MschxudpExporter.js';
import { MsPinyinImporter } from '../src/implementations/importer/MsPinyinImporter.js';
import { promises as fs } from 'fs';

const TEST = { code: 'imetest', word: '一键导入测试成功', order: 1 };
const noReload = process.argv.includes('--no-reload');

const exporter = new MschxudpExporter();
const importer = new MsPinyinImporter();
const target = importer.eudpPath;

// 1. 读取并展示当前词条
let before = [];
try { before = exporter._parse(await fs.readFile(target)); } catch {}
console.log(`目标文件: ${target}`);
console.log(`写入前词条数: ${before.length}`);
before.forEach((e, i) => console.log(`  [${i}] ${e.code} → ${e.word} (位置${e.candidate})`));

// 2. 合并构建（merge=true 保留现有词条）
const buf = await exporter.export([TEST], { filePath: target });

// 3. 备份 + 原子写入
const backupPath = await importer._writeWithBackup(target, buf);
console.log(`\n已写入: ${TEST.code} → ${TEST.word} (候选位置${TEST.order})`);
console.log(`备份文件: ${backupPath || '(原文件不存在，无备份)'}`);

// 4. 回读验证
const after = exporter._parse(await fs.readFile(target));
console.log(`写入后词条数: ${after.length}`);
after.forEach((e, i) => console.log(`  [${i}] ${e.code} → ${e.word} (位置${e.candidate})`));
const ok = after.some((e) => e.code === TEST.code && e.word === TEST.word);
console.log(ok ? '✅ 回读校验通过' : '❌ 回读校验失败');

// 5. 重载 IME（可能弹 UAC）
if (!noReload) {
  console.log('\n正在重载输入法（若弹出 UAC 请点击"是"）...');
  const r = await importer.reloadIme();
  console.log('重载结果:', JSON.stringify(r));
  if (!r.killedChsIME) {
    console.log('⚠️ ChsIME.exe 未能重启，请手动切换一次输入法（Win+空格 来回切换）后再测试');
  }
} else {
  console.log('\n已跳过重载，请手动切换一次输入法后测试');
}
