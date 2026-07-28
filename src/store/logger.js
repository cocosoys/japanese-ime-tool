import { promises as fs } from 'fs';
import path from 'path';

/**
 * 日志模块 → ./data/logs/YYYY-MM-DD.log
 * 按天滚动，追加写入，行格式：[2026-07-28 09:32:01] [INFO] 消息
 */
function pad(n) { return String(n).padStart(2, '0'); }

function localStamp(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function dateName(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export class Logger {
  constructor({ dir } = {}) {
    this.dir = dir || path.join(process.cwd(), 'data', 'logs');
  }

  async _write(level, msg) {
    const now = new Date();
    const line = `[${localStamp(now)}] [${level}] ${msg}\n`;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(path.join(this.dir, `${dateName(now)}.log`), line, 'utf8');
    } catch { /* 日志失败不影响主流程 */ }
    // 同时输出到控制台便于开发调试
    if (level === 'ERROR') console.error(line.trimEnd());
    else console.log(line.trimEnd());
  }

  info(msg)  { return this._write('INFO', msg); }
  warn(msg)  { return this._write('WARN', msg); }
  error(msg) { return this._write('ERROR', msg); }
}
