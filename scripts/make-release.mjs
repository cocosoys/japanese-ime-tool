// 发布辅助：在 `npm run dist` 之后执行。
// 1) 把打包产物 resources/app.asar 复制为 app-<version>.asar（GitHub Release 资产）
// 2) 更新仓库根 version.json：追加本版本记录（历史永删）、置 current 为最新
// 之后需手动将 app-<version>.asar 与 version.json 上传到对应 GitHub Release。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const assetName = `app-${version}.asar`;
const asarSrc = path.join(root, 'release-v2', 'win-unpacked', 'resources', 'app.asar');
const asarDest = path.join(root, assetName);

if (!fs.existsSync(asarSrc)) {
  console.error('未找到打包后的 asar：', asarSrc, '\n请先执行 `npm run dist`。');
  process.exit(1);
}

fs.copyFileSync(asarSrc, asarDest);
console.log('[asar] 已复制', assetName, `(${(fs.statSync(asarDest).size / 1024 / 1024).toFixed(1)} MB)`);

// 更新 version.json
const vPath = path.join(root, 'version.json');
const today = new Date().toISOString().slice(0, 10);
let data;
try {
  data = JSON.parse(fs.readFileSync(vPath, 'utf8'));
} catch {
  data = { versions: [] };
}
if (!Array.isArray(data.versions)) data.versions = [];

const exists = data.versions.some((v) => v.version === version);
if (!exists) {
  data.versions.push({
    version,
    notes: process.argv[2] || `版本 ${version}`,
    pubAt: today,
    mandatory: false,
    tag: `v${version}`,
    assets: { win: assetName },
  });
  console.log('[ver ] 已追加版本记录', version);
} else {
  console.log('[ver ] 版本', version, '已存在，跳过追加');
}
data.current = version;
data.updatedAt = today;
fs.writeFileSync(vPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('[ver ] current =', version);

console.log('\n下一步：');
console.log(`  1) 在 GitHub 创建 Release v${version}`);
console.log(`  2) 上传资产：${assetName} 与 version.json`);
console.log(`  3) 推送 version.json 到 ${'main'} 分支（确保 raw.githubusercontent.com 可访问）`);
console.log(`  4) 下载加速镜像：https://gh.xmly.dev/https://github.com/cocosoys/japanese-ime-tool/releases/download/v${version}/${assetName}`);
