// 版本信息客户端：拉取仓库根 version.json（原始直连优先，镜像回退），并归一化。
import https from 'https';
import http from 'http';
import { rawVersionUrl, mirrorUrl } from './repoConfig.js';

// 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https') ? https : http).get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 拉取并归一化版本信息；返回 { current, updatedAt, repo, versions(升序), latest }
export async function fetchVersionInfo() {
  const urls = [rawVersionUrl(), mirrorUrl(rawVersionUrl())];
  let lastErr;
  for (const u of urls) {
    try {
      const json = JSON.parse(await fetchText(u));
      if (!json || !Array.isArray(json.versions)) throw new Error('version.json 结构异常');
      const versions = [...json.versions].sort((a, b) => compareVersions(a.version, b.version));
      const latest = versions[versions.length - 1]?.version || json.current;
      return {
        current: json.current || latest,
        updatedAt: json.updatedAt,
        repo: json.repo,
        versions,
        latest,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无法获取版本信息');
}
