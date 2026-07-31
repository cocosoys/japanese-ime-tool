// 更新子系统对外统一出口（供 main.js 引入）
export {
  getRunningVersion,
  ensureRunningMarker,
  checkForUpdate,
  listVersions,
  applyVersion,
  applyPendingOnStartup,
} from './asarUpdater.js';

export { compareVersions, fetchVersionInfo } from './versionClient.js';
export {
  rawVersionUrl,
  mirrorUrl,
  releaseAssetUrl,
  assetNameFor,
  OWNER,
  REPO,
  BRANCH,
  MIRROR_BASE,
} from './repoConfig.js';
