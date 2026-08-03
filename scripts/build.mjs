// 统一构建脚本：混淆 → 构建 NSIS 安装版 → 构建便携版 →
// 把全部产物整理进版本化目录 release/<version>/ → 抽取 app-<version>.asar → 刷新 version.json。
//
// 产物结构（release/<version>/）：
//   JapaneseImeTool Setup <version>.exe        (NSIS 安装版)
//   JapaneseImeTool Portable <version>.exe     (便携免安装版)
//   app-<version>.asar                         (应用内更新资源)
//   win-unpacked/ latest.yml *.blockmap ...    (构建副产物，随版本归档)
//
// 用法：npm run dist   （或 npm run release，等价）
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { build } from 'electron-builder';

// ── 构建环境：GitHub 镜像 + 关闭签名自动发现 ──────────────────────────────
// 1) ELECTRON_BUILDER_BINARIES_MIRROR：
//    electron-builder 构建时需从 GitHub 下载辅助二进制（NSIS / 7zip / winCodeSign 等），
//    直连 GitHub 经常 ETIMEDOUT。改用 gh.xmly.dev 镜像（保留 release tag 目录结构，
//    拼接逻辑见 electronGet.js 的 getBinariesMirrorUrl：mirror + "/<tag>/<file>"）。
//    ⚠ 不能用 OVERRIDE_URL：它会丢掉 tag 目录导致 404。
//    仅本地构建生效；CI 环境（CI=true）保持直连 GitHub（runner 网络可达）。
// 2) 注意：不要对 electron 运行时本身设置镜像（ELECTRON_MIRROR）。gh.xmly.dev 代理
//    不返回 electron 的 .sha256sum 校验和文件，会导致 404。electron 走默认直连即可。
// 3) CSC_IDENTITY_AUTO_DISCOVERY=false：构建阶段不自动签名（签名由
//    scripts/local-release/release.mjs 或 CI 单独步骤完成），避免无证书时下载
//    winCodeSign，并保证本地/CI 构建行为一致。
const GH_MIRROR = 'https://gh.xmly.dev/https://github.com/electron-userland/electron-builder-binaries/releases/download';
if (!process.env.CI && !process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = GH_MIRROR;
}
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const pkgBuild = pkg.build || {};
const outBase = path.join(root, 'release'); // electron-builder 临时输出根
const outVer = path.join(outBase, version); // 版本化归档目录

const rel = (p) => path.relative(root, p);
const log = (...a) => console.log('[build]', ...a);

async function obfuscate() {
  log('混淆源码 → build/app');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'obfuscate.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[build] obfuscate 失败');
    process.exit(1);
  }
}

async function buildTarget(target) {
  log(`构建 ${target} → ${rel(outBase)}`);
  await build({
    projectDir: root,
    // 关闭 electron-builder 的隐式发布：
    // 发布改由 GitHub Action（auto-release + upload-release-asset）负责，
    // 否则 electron-builder 在 CI / 本地检测到 GH_TOKEN 或 CI 环境时会自动尝试
    // 发布到 GitHub Releases 而缺少 token 报错。
    // 注意：必须用字符串 "never"，不能写 false —— electron-builder 的判定里
    // `false != null` 为 true，会把 false 当成“有发布策略”而继续发布。
    publish: "never",
    config: {
      ...pkgBuild,
      directories: { ...(pkgBuild.directories || {}), output: outBase },
      win: { ...(pkgBuild.win || {}), target: [target] },
    },
  });
}

async function organize() {
  // 干净重建：移除旧的版本化目录
  await fs.rm(outVer, { recursive: true, force: true });
  await fs.mkdir(outVer, { recursive: true });

  const entries = await fs.readdir(outBase, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === version) continue; // 不要把目标目录移进自己
    const src = path.join(outBase, e.name);
    const dst = path.join(outVer, e.name);
    await fs.rename(src, dst);
    log('归档', e.name, '→', path.join(version, e.name));
  }

  const asarSrc = path.join(outVer, 'win-unpacked', 'resources', 'app.asar');
  const asarDst = path.join(outVer, `app-${version}.asar`);
  await fs.copyFile(asarSrc, asarDst);
  log('抽取更新资源', path.join(version, `app-${version}.asar`));
}

async function updateVersionJson() {
  const vPath = path.join(root, 'version.json');
  let data;
  try {
    data = JSON.parse(await fs.readFile(vPath, 'utf8'));
  } catch {
    data = { versions: [] };
  }
  if (!Array.isArray(data.versions)) data.versions = [];
  const today = new Date().toISOString().slice(0, 10);
  if (!data.versions.some((v) => v.version === version)) {
    data.versions.push({
      version,
      notes: `版本 ${version}`,
      pubAt: today,
      mandatory: false,
      tag: `v${version}`,
      assets: { win: `app-${version}.asar` },
    });
    log('version.json 追加记录', version);
  } else {
    log('version.json 已有记录', version, '（跳过追加）');
  }
  data.current = version;
  data.updatedAt = today;
  await fs.writeFile(vPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  log('版本', version);
  await obfuscate();
  await buildTarget('nsis');
  await buildTarget('portable');
  await organize();
  await updateVersionJson();
  log('构建完成 →', rel(outVer));
  log('  ' + path.join(version, `JapaneseImeTool Setup ${version}.exe`));
  log('  ' + path.join(version, `JapaneseImeTool Portable ${version}.exe`));
  log('  ' + path.join(version, `app-${version}.asar`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
