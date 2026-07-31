import path from 'path';
import { createRequire } from 'module';

// 应用数据目录解析（与 langPaths.js 同策略）：
// - 开发模式：项目根 /data（与现有约定一致，可直接编辑）
// - 生产模式（packaged）：用户数据目录下的 data（app.getPath('userData')/data），
//   始终可写、不进 asar，避免安装到 Program Files 后普通用户无写入权限。
//
// electron 仅在 Electron 运行时存在；用 createRequire + process.versions.electron 守卫，
// 避免纯 Node（单元测试 / API 服务）加载 electron 模块而报错。

const require = createRequire(import.meta.url);

function getElectronApp() {
  if (!process.versions || !process.versions.electron) return null;
  try {
    const electron = require('electron');
    return electron.app || null;
  } catch {
    return null;
  }
}

/** 应用数据根目录（开发 cwd/data；生产 userData/data） */
export function getDataBaseDir() {
  const app = getElectronApp();
  if (app && app.isPackaged) return path.join(app.getPath('userData'), 'data');
  return path.join(process.cwd(), 'data');
}

/** 用户数据目录（开发 cwd；生产 app.getPath('userData')） */
export function getUserDataPath() {
  const app = getElectronApp();
  if (app && app.isPackaged) return app.getPath('userData');
  return process.cwd();
}
