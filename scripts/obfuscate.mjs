// 打包前混淆：对主进程 / preload / 渲染层 / src 下的 JS 做 javascript-obfuscator 处理，
// 非 JS 资源（html/css/json）原样复制到 build/app，最终由 electron-builder 打包为 asar。
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jo from 'javascript-obfuscator';
const { obfuscate } = jo;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'build', 'app');

const OBF_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.7,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.7,
  renameGlobals: false, // 不重命名全局/导出名，避免破坏 ESM import/export 契约
  identifierNamesGenerator: 'hexadecimal',
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

// 显式混淆入口
const OBF_ENTRIES = ['main.js', 'preload.cjs', 'renderer/app.js'];
// 显式复制（原样）
const COPY_ENTRIES = ['renderer/index.html', 'renderer/style.css', 'preload.js'];

async function collectSrcJs() {
  const acc = [];
  const skipDirs = new Set(['cli']); // src/cli 为命令行工具，不打包
  async function walk(dir, relBase) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.join(relBase, e.name).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        await walk(full, rel);
      } else if (e.name.endsWith('.js')) {
        acc.push(rel);
      }
    }
  }
  await walk(path.join(root, 'src'), 'src');
  return acc;
}

async function collectLangJson() {
  const dir = path.join(root, 'data', 'lang');
  const files = await fs.readdir(dir);
  return files.filter((f) => f.endsWith('.json')).map((f) => path.join('data', 'lang', f).split(path.sep).join('/'));
}

function obfuscateFile(rel) {
  return (async () => {
    const src = path.join(root, rel);
    const dest = path.join(outDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const code = await fs.readFile(src, 'utf8');
    const result = obfuscate(code, OBF_OPTIONS);
    const obf = result.getObfuscatedCode();
    await fs.writeFile(dest, obf, 'utf8');
    console.log('[obf]', rel);
  })();
}

function copyFile(rel) {
  return (async () => {
    const src = path.join(root, rel);
    const dest = path.join(outDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    console.log('[cp ]', rel);
  })();
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const srcJs = await collectSrcJs();
  const langJson = await collectLangJson();
  const toObfuscate = [...OBF_ENTRIES, ...srcJs];
  const toCopy = [...COPY_ENTRIES, ...langJson];

  await Promise.all(toObfuscate.map(obfuscateFile));
  await Promise.all(toCopy.map(copyFile));

  // 生成运行期 package.json（保留 dependencies 供 electron-builder 解析 cheerio）
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const appPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    dependencies: pkg.dependencies || {},
  };
  await fs.writeFile(path.join(outDir, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8');
  console.log('[done] build/app ready:', toObfuscate.length, 'obfuscated,', toCopy.length, 'copied');
}

main().catch((e) => {
  console.error('obfuscate failed:', e);
  process.exit(1);
});
