// asar 热替换更新器（主进程）：
//  - 下载目标版本 asar（GitHub Release 直连 + gh.xmly.dev 镜像回退）
//  - 交换 resources/app.asar，并对旧 asar 做备份（支持回滚）
//  - 安装到 Program Files 等只读目录时，首次覆盖弹一次 UAC 提权
//  - 用 userData/updates/current.json 记录「当前运行版本」，不受 asar 内 package.json 影响
//  - 运行时替换若因文件被占用失败，写入 pending，待下次启动早期再替换
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { compareVersions, fetchVersionInfo } from './versionClient.js';
import { releaseAssetUrl, assetNameFor } from './repoConfig.js';
import { downloadWithFallback } from './download.js';

const updatesDir = () => path.join(app.getPath('userData'), 'updates');
const cacheDir = () => path.join(updatesDir(), 'cache');
const backupDir = () => path.join(updatesDir(), 'backup');
const currentMarker = () => path.join(updatesDir(), 'current.json');
const pendingMarker = () => path.join(updatesDir(), 'pending.json');

// 当前运行版本（优先读标记，缺失则回退 app.getVersion）
export function getRunningVersion() {
  try {
    return JSON.parse(fs.readFileSync(currentMarker(), 'utf8')).version;
  } catch {
    return app.getVersion();
  }
}

// 启动早期确保运行版本标记存在
export async function ensureRunningMarker() {
  try {
    await fsp.mkdir(updatesDir(), { recursive: true });
    if (!fs.existsSync(currentMarker())) {
      await fsp.writeFile(currentMarker(), JSON.stringify({ version: app.getVersion() }), 'utf8');
    }
  } catch { /* 非致命 */ }
}

// 检查更新：返回 { running, latest, hasUpdate, current, updatedAt }
export async function checkForUpdate() {
  const info = await fetchVersionInfo();
  const running = getRunningVersion();
  return {
    running,
    latest: info.latest,
    hasUpdate: compareVersions(info.latest, running) > 0,
    current: info.current,
    updatedAt: info.updatedAt,
  };
}

// 列出全部版本（含状态）：running / newer / older
export async function listVersions() {
  const info = await fetchVersionInfo();
  const running = getRunningVersion();
  return {
    running,
    latest: info.latest,
    current: info.current,
    versions: info.versions.map((v) => ({
      ...v,
      state:
        compareVersions(v.version, running) === 0
          ? 'running'
          : compareVersions(v.version, info.latest) > 0
          ? 'newer'
          : 'older',
    })),
  };
}

// 下载并应用某版本（回滚本质也是调用它）
export async function applyVersion(version, onProgress, onLog) {
  const info = await fetchVersionInfo();
  const entry = info.versions.find((v) => v.version === version);
  if (!entry) throw new Error(`版本 ${version} 不存在于版本列表`);

  const assetName = entry.assets?.win || assetNameFor(version);
  const url = releaseAssetUrl(version, assetName);

  const target = path.join(cacheDir(), version, assetName);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  await downloadWithFallback(
    url,
    target,
    (pct) => onProgress?.(pct),
    (msg) => onLog?.(msg)
  );

  const st = await fsp.stat(target);
  if (!st.size) throw new Error('下载的 asar 文件为空');

  try {
    await swapAsar(target, version);
    onProgress?.(100);
    return { ok: true, applied: true, version };
  } catch (e) {
    // 运行时替换失败（asar 被占用）：写入 pending，待下次启动早期替换
    await fsp.writeFile(pendingMarker(), JSON.stringify({ src: target, version }), 'utf8');
    onLog?.(`运行时替换失败（${e.message}），将在下次启动时应用，请重启`);
    return { ok: true, applied: false, pending: true, version, error: e.message };
  }
}

// 启动早期应用 pending（覆盖在 main.js app.whenReady 最前面调用）
export async function applyPendingOnStartup() {
  try {
    if (!fs.existsSync(pendingMarker())) return;
    const { src, version } = JSON.parse(fs.readFileSync(pendingMarker(), 'utf8'));
    if (!src || !fs.existsSync(src)) {
      fs.unlinkSync(pendingMarker());
      return;
    }
    await swapAsar(src, version);
    fs.unlinkSync(pendingMarker());
  } catch (e) {
    // 仍失败则保留 pending，下次再试；不阻塞启动
    try { fs.appendFileSync(path.join(updatesDir(), 'pending.log'), `\n${new Date().toISOString()} ${e.message}`); } catch {}
  }
}

// ── 内部：asar 交换 ──
async function swapAsar(srcAsar, version) {
  const resourcesPath = process.resourcesPath;
  const destAsar = path.join(resourcesPath, 'app.asar');
  await fsp.mkdir(backupDir(), { recursive: true });
  const oldVersion = getRunningVersion();
  const backupFile = path.join(backupDir(), `app-${oldVersion}-${Date.now()}.asar`);

  if (await isWritable(resourcesPath)) {
    if (fs.existsSync(destAsar)) await fsp.copyFile(destAsar, backupFile);
    await fsp.copyFile(srcAsar, destAsar);
  } else {
    // 只读安装目录：一次性 UAC 提权复制
    await elevateCopy(srcAsar, destAsar, backupFile);
  }
  await fsp.mkdir(updatesDir(), { recursive: true });
  await fsp.writeFile(currentMarker(), JSON.stringify({ version }), 'utf8');
}

async function isWritable(dir) {
  try {
    const test = path.join(dir, `.wtest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.writeFile(test, '');
    await fsp.unlink(test);
    return true;
  } catch {
    return false;
  }
}

// 写临时 ps1 到可写目录，再提权执行（仅复制，不做逻辑判断，免去引号地狱）
async function elevateCopy(src, dest, backup) {
  const ps1 = path.join(updatesDir(), `apply-update-${Date.now()}.ps1`);
  const script = [
    `if (Test-Path "${dest.replace(/"/g, '`"')}") { Copy-Item "${dest.replace(/"/g, '`"')}" "${backup.replace(/"/g, '`"')}" -Force }`,
    `Copy-Item "${src.replace(/"/g, '`"')}" "${dest.replace(/"/g, '`"')}" -Force`,
    'exit 0',
  ].join('\n');
  await fsp.writeFile(ps1, script, 'utf8');
  await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -FilePath "${ps1}"`],
      { windowsHide: true }
    );
    child.on('exit', (code) => {
      fsp.unlink(ps1).catch(() => {});
      if (code === 0) resolve();
      else reject(new Error(`提权复制失败（退出码 ${code}）`));
    });
    child.on('error', reject);
  });
}
