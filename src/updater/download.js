// 通用下载器：支持重定向跟随、进度回调、直连失败自动回退镜像。
import fs from 'fs';
import https from 'https';
import http from 'http';
import { mirrorUrl } from './repoConfig.js';

function libFor(url) {
  return url.startsWith('https') ? https : http;
}

function doDownload(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = libFor(url).get(url, { timeout: 30000 }, (res) => {
      // 跟随重定向（GitHub Release 会 302 到 CDN）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        doDownload(next, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} (${url})`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let done = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        done += chunk.length;
        if (total && onProgress) onProgress(Math.min(100, Math.floor((done / total) * 100)), done, total);
      });
      res.pipe(out);
      out.on('finish', () => resolve(true));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 先直连，失败回退镜像；onLog 用于上报回退原因
export async function downloadWithFallback(url, dest, onProgress, onLog) {
  try {
    await doDownload(url, dest, onProgress);
    return true;
  } catch (e) {
    onLog?.(`直连下载失败，改用镜像加速：${e.message}`);
    await doDownload(mirrorUrl(url), dest, onProgress);
    return true;
  }
}
