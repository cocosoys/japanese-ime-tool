import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_TMP = path.join(os.tmpdir(), 'japanese_names.json');

/**
 * 生成精确到秒 + 毫秒时间戳的目录名，如 2026-07-31_112021_1785468046751
 * 格式：年-月-日_时分秒_自1970-01-01T00:00:00Z以来的毫秒数（13 位）
 */
function dateDirName(now = new Date()) {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getTime()); // 自 UTC+0 以来的毫秒数（13 位数字）
  return `${y}-${mo}-${d}_${h}${min}${s}_${ms}`;
}

/** name.json 中每个子对象只保留这三个属性 */
function stripEntry(e) {
  return {
    kanji: e.kanji || '',
    romaji: e.romaji || '',
    hiragana: e.hiragana || '',
  };
}

/**
 * 批次目录名识别正则 —— 兼容新旧两种命名格式：
 *   新格式：YYYY-MM-DD_HHmmss_<13位毫秒>（如 2026-07-31_114932_1785469772230）
 *   旧格式：YYYY-MM-DD_HHmm（如 2026-07-31_1127，历史遗留）
 */
const BATCH_DIR_RE = /^\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2}_\d{13})?$/;

/**
 * 数据存储：
 *   归档目录 — ./data/names_data/日期(到秒+毫秒)/response.html + name.json
 *   临时文件 — %TEMP%/japanese_names.json（UI 快速读取用）
 */
export class TempJsonStore {
  /**
   * @param {object} opts
   * @param {string} [opts.baseDir] - 名称数据根目录（默认 ./data/names_data）
   * @param {string} [opts.tmpFile] - 临时 JSON 路径（兼容旧逻辑）
   */
  constructor(opts = {}) {
    this.baseDir = opts.baseDir || path.join(process.cwd(), 'data', 'names_data');
    this.tmpFile = opts.tmpFile || DEFAULT_TMP;
    this._currentDir = null;  // 当前抓取会话的日期目录
  }

  // ─── 临时模式（兼容） ───

  async save(entries) {
    await fs.writeFile(this.tmpFile, JSON.stringify(entries.map(stripEntry), null, 2), 'utf8');
    return this.tmpFile;
  }

  async load() {
    try {
      const t = await fs.readFile(this.tmpFile, 'utf8');
      return JSON.parse(t);
    } catch { return null; }
  }

  // ─── 数据归档模式 ───

  /**
   * 创建/获取当前时间戳的数据目录（如 ./data/names_data/2026-07-31_114932_1785469772230/）
   * 同一次抓取会话内多次调用返回同一目录；新抓取前调用 resetDir()。
   */
  async getDataDir() {
    if (this._currentDir) return this._currentDir;
    const dir = path.join(this.baseDir, dateDirName());
    await fs.mkdir(dir, { recursive: true });
    this._currentDir = dir;
    return dir;
  }

  /**
   * 保存原始 HTML 响应 → names_data/日期/response.html
   */
  async saveHtml(html) {
    const dir = await this.getDataDir();
    const filePath = path.join(dir, 'response.html');
    await fs.writeFile(filePath, html, 'utf8');
    return filePath;
  }

  /**
   * 解析后的名字数组 → names_data/日期/name.json
   * 每个子对象只存 kanji / romaji / hiragana 三个属性。
   */
  async saveNamesJson(entries) {
    const dir = await this.getDataDir();
    const filePath = path.join(dir, 'name.json');
    const slim = entries.map(stripEntry);
    await fs.writeFile(filePath, JSON.stringify(slim, null, 2), 'utf8');
    // 同时写一份到临时位置供 UI 快速读取
    await fs.writeFile(this.tmpFile, JSON.stringify(slim, null, 2), 'utf8');
    return filePath;
  }

  /**
   * 读取最新一次抓取的 name.json
   */
  async loadNamesJson() {
    try {
      const dirs = (await fs.readdir(this.baseDir))
        .filter(d => BATCH_DIR_RE.test(d))
        .sort()
        .reverse();
      if (dirs.length) {
        const fp = path.join(this.baseDir, dirs[0], 'name.json');
        const t = await fs.readFile(fp, 'utf8');
        return JSON.parse(t);
      }
    } catch { /* fall through */ }
    return this.load();  // 回退到临时文件
  }

  /**
   * 重置日期目录缓存（每次新抓取前调用，生成新的时间戳目录）
   */
  resetDir() {
    this._currentDir = null;
  }

  // ─── 批次管理（不同日期生成的名称） ───

  /**
   * 列出所有批次目录名（按时间倒序，最新在前）
   */
  async listBatches() {
    try {
      return (await fs.readdir(this.baseDir))
        .filter((d) => BATCH_DIR_RE.test(d))
        .sort()
        .reverse();
    } catch { return []; }
  }

  /**
   * 加载指定批次的名称数据与已使用记录
   * @returns {{entries: object[], used: string[]}}
   */
  async loadBatch(batch) {
    const dir = path.join(this.baseDir, batch);
    let entries = [];
    let used = [];
    try { entries = JSON.parse(await fs.readFile(path.join(dir, 'name.json'), 'utf8')); } catch { /* 无数据 */ }
    try { used = JSON.parse(await fs.readFile(path.join(dir, 'used.json'), 'utf8')); } catch { /* 尚无 used.json */ }
    return { entries, used };
  }

  /**
   * 保存指定批次的已使用名称列表 → names_data/批次/used.json
   * @param {string} batch - 批次目录名
   * @param {string[]} usedList - 已使用名称（kanji）数组
   */
  async saveUsed(batch, usedList) {
    const dir = path.join(this.baseDir, batch);
    await fs.mkdir(dir, { recursive: true });
    const fp = path.join(dir, 'used.json');
    await fs.writeFile(fp, JSON.stringify([...new Set(usedList)], null, 2), 'utf8');
    return fp;
  }

  /**
   * 删除指定批次目录（含 name.json / used.json / response.html 等所有数据）。
   * 关联绑定的清理由调用方负责（见 BindingsStore.saveBatch(batch, {})）。
   * @param {string} batch - 批次目录名
   */
  async deleteBatch(batch) {
    if (!batch) return false;
    const dir = path.join(this.baseDir, batch);
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }
}
