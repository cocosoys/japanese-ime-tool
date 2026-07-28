import { NameSource } from '../../interfaces/NameSource.js';

// namechef.co 日文名生成器来源。需手动粘贴 cf_clearance cookie（沿用你的流程）。
export class NamechefSource extends NameSource {
  constructor({ cookie = '', userAgent } = {}) {
    super();
    this.cookie = cookie;
    this.userAgent = userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  }

  /**
   * 规范化 Cookie 字符串。
   * 用户可能粘贴：
   *   - 裸值：一长串 token（最常见）
   *   - 完整头：cf_clearance=xxxx
   *   - 多组：cf_clearance=xxx; other=yyy
   * 统一处理为标准 Cookie 头格式。
   */
  normalizeCookie(raw) {
    if (!raw || !raw.trim()) return '';
    const s = raw.trim();

    // 已经是完整的 name=value 格式（含 = 号且不在开头）
    if (s.includes('=') && !s.startsWith('=')) return s;

    // 裸 token → 自动加 cf_clearance= 前缀
    return `cf_clearance=${s}`;
  }

  buildUrl({ gender = 'G', last_name_type = 'random', last_name = '', popularity = 'popular' } = {}) {
    const p = new URLSearchParams({ gender, last_name_type, last_name });
    p.append('popularity[]', popularity);
    return `https://www.namechef.co/cn/name-generator/japanese/?${p.toString()}`;
  }

  async fetchNames({ cookie, url, gender = 'G', popularity = 'popular' } = {}) {
    const target = url || this.buildUrl({ gender, popularity });
    const cookies = this.normalizeCookie(cookie || this.cookie);

    if (!cookies) throw new Error('未提供 Cloudflare Cookie，请先粘贴 cf_clearance 值');

    const res = await fetch(target, {
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': target,
        'Cookie': cookies,
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
    });

    if (!res.ok) {
      if (res.status === 403) {
        throw new Error(
          `请求失败: ${res.status} Forbidden（Cloudflare 拦截）。` +
          `原因：cf_clearance cookie 已过期或无效。` +
          `解决：重新从浏览器 DevTools → Application → Cookies 复制最新的 cf_clearance 值粘贴到上方输入框，然后重试。`
        );
      }
      throw new Error(`请求失败: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  }
}
