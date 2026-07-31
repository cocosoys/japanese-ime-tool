// 更新子系统纯逻辑测试（不触网）：版本比较、镜像/Release URL 拼接
import assert from 'assert';
import { compareVersions } from '../src/updater/versionClient.js';
import { mirrorUrl, releaseAssetUrl, assetNameFor, rawVersionUrl } from '../src/updater/repoConfig.js';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('✓', name); pass++; }
  catch (e) { console.error('✗', name, '-', e.message); fail++; }
}

ok('compareVersions 语义化比较', () => {
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('2.0.0', '1.9.9'), 1);
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
});

ok('mirrorUrl 在完整原始 URL 前拼接镜像前缀', () => {
  const u = 'https://raw.githubusercontent.com/cocosoys/japanese-ime-tool/main/version.json';
  assert.strictEqual(mirrorUrl(u), 'https://gh.xmly.dev/' + u);
});

ok('releaseAssetUrl 拼出 GitHub Release 直链', () => {
  assert.strictEqual(
    releaseAssetUrl('1.0.0', 'app-1.0.0.asar'),
    'https://github.com/cocosoys/japanese-ime-tool/releases/download/v1.0.0/app-1.0.0.asar'
  );
});

ok('assetNameFor 模板替换', () => {
  assert.strictEqual(assetNameFor('1.2.3'), 'app-1.2.3.asar');
});

ok('rawVersionUrl 指向仓库根 version.json', () => {
  assert.ok(rawVersionUrl().endsWith('/version.json'));
});

console.log(`\nupdater 测试：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
