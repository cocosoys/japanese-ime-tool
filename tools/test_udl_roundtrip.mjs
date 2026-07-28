import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { MspyUdlExporter } from '../src/implementations/exporter/MspyUdlExporter.js';

const realPath = process.env.APPDATA + '\\Microsoft\\InputMethod\\Chs\\ChsPinyinUDL.dat';
const tmpDir = process.env.TEMP + '\\udl_test';
mkdirSync(tmpDir, { recursive: true });
const tmpPath = tmpDir + '\\ChsPinyinUDL_test.dat';

// 1) 复制真实文件到临时位置（用于合并测试，不触碰真实文件）
copyFileSync(realPath, tmpPath);

const exporter = new MspyUdlExporter();

// 2) 准备 2 条新记录：绑定码 + 词
const records = [
  { code: 'q', word: '筱水由季' },
  { code: 'w', word: '佐藤樱花' },
];

// 3) 导出（读取临时文件中的已有内容并合并）
const buf = await exporter.export(records, { filePath: tmpPath });

// 4) 写回临时文件
writeFileSync(tmpPath, buf);

// 5) 校验结果
function validate(fp, expectNew) {
  const b = readFileSync(fp);
  const magic = b.toString('hex', 0, 4);
  const count = b.readUInt32LE(0x0c);
  const header4 = b.toString('hex', 4, 8);
  const check = b.toString('hex', 8, 12);
  const dataBytes = b.length - 0x2400;
  const entries = [];
  let bad = 0;
  for (let i = 0; i < count; i++) {
    const off = 0x2400 + i * 60;
    if (off + 60 > b.length) { bad++; break; }
    const wl = b[off + 10];
    const sep = b[off + 11];
    if (sep !== 0x5a) { bad++; continue; }
    const word = b.slice(off + 12, off + 12 + wl * 2).toString('utf16le');
    const code = b.toString('latin1', off + 4, off + 7).replace(/\0+$/, '');
    entries.push({ i, code, word });
  }
  return { magic, count, header4, check, dataBytes, entries, bad };
}

const before = readFileSync(realPath);
const beforeCount = before.readUInt32LE(0x0c);

const v = validate(tmpPath);
console.log('=== 校验结果 ===');
console.log('magic:', v.magic, '(应为 55aa8881)');
console.log('offset4:', v.header4, '(应为 02006000)');
console.log('check:', v.check, '(应为 55aa55aa)');
console.log('合并前 count:', beforeCount);
console.log('合并后 count:', v.count, '(应为', beforeCount + records.length, ')');
console.log('数据区字节:', v.dataBytes, '= count*60?', v.dataBytes === v.count * 60);
console.log('坏条目:', v.bad);
console.log('新增词是否在末尾:',
  v.entries.slice(-2).map(e => `${e.code}->${e.word}`));

const ok = v.magic === '55aa8881' &&
  v.header4 === '02006000' &&
  v.check === '55aa55aa' &&
  v.count === beforeCount + records.length &&
  v.dataBytes === v.count * 60 &&
  v.bad === 0;

console.log('\n==> 校验', ok ? '通过 ✅' : '失败 ❌');
if (!ok) process.exit(2);

// 6) 校验通过 → 备份真实文件并写入真实路径
const bak = realPath + '.bak_' + Date.now();
copyFileSync(realPath, bak);
writeFileSync(realPath, buf);
console.log('已备份真实文件 →', bak);
console.log('已写入真实文件 →', realPath);
console.log('请打开任意输入框，键入 q 然后空格，应出现「筱水由季」；键入 w 然后空格，应出现「佐藤樱花」。');
