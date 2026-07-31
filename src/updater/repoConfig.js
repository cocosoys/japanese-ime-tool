// 仓库坐标与镜像配置：打包后从 app.asar 内的 package.json 读取 updater 字段，
// 否则回退到与「关于」面板 GitHub 链接一致的硬编码默认值。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function readPkgUpdater() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/updater -> ../../package.json（开发期项目根 / 打包后 app.asar 根）
    const pkgPath = path.resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.updater || {};
  } catch {
    return {};
  }
}

const cfg = readPkgUpdater();

// GitHub 仓库坐标
export const OWNER = cfg.owner || 'cocosoys';
export const REPO = cfg.repo || 'japanese-ime-tool';
export const BRANCH = cfg.branch || 'main';

// GitHub 下载加速镜像（gh.xmly.dev）：在「完整原始 URL」前拼接此前缀即可
export const MIRROR_BASE = (cfg.mirror || 'https://gh.xmly.dev/').replace(/\/$/, '') + '/';

// 每个版本对应的 asar 资源名模板（如 app-1.0.0.asar）
export const ASSET_TPL = cfg.assetName || 'app-{version}.asar';

// version.json 在仓库根的原始直链
export function rawVersionUrl() {
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/version.json`;
}

// 任意原始 URL 经镜像加速：https://gh.xmly.dev/<原始完整 URL>
export function mirrorUrl(url) {
  return MIRROR_BASE + url;
}

// GitHub Release 资产直链
export function releaseAssetUrl(version, assetName) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${assetName}`;
}

// 按版本号生成资产名
export function assetNameFor(version) {
  return ASSET_TPL.replace('{version}', version);
}
