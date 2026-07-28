import { ImeImporter } from '../../interfaces/ImeImporter.js';
import { MschxudpExporter } from '../exporter/MschxudpExporter.js';
import { MsPinyinDatExporter } from '../exporter/MsPinyinDatExporter.js';
import { promises as fs } from 'fs';
import { exec, execFile, spawn } from 'child_process';
import path from 'path';

/**
 * 写入微软拼音「用户自定义短语」并触发 IME 重载。
 *
 * Win11 23H2+ 使用两个文件：
 *   - ChsPinyinUDL.dat (0x55AA8881 格式) — 智能短语抽取引擎
 *   - CustomPhrases/ChsUserPhrase.dat (machxudp 格式) — 设置界面管理的用户自定义短语
 *
 * 关键：ChsIME.exe 以提升权限运行，普通用户无法终止。
 * 重载策略：
 *   1. 先尝试非提升方式（taskkill + WM_SETTINGCHANGE）
 *   2. 若 ChsIME 未被终止，自动请求 UAC 提升权限执行重载
 */
export class MsPinyinImporter extends ImeImporter {
  constructor() {
    super();
    this.defaultDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Microsoft', 'InputMethod', 'Chs')
      : '';
    this.defaultFile = 'ChsPinyinUDL.dat';
    this.mschxudpExporter = new MschxudpExporter();
    this.machxudpExporter = new MsPinyinDatExporter();
  }

  get targetPath() { return path.join(this.defaultDir, this.defaultFile); }

  /** Win11 23H2+ Settings「用户自定义短语」实际写入/读取的文件（mschxudp 格式）。 */
  get eudpPath() {
    return path.join(this.defaultDir, 'ChsPinyinEUDPv1.lex');
  }

  get legacyPath() {
    return path.join(this.defaultDir, 'CustomPhrases', 'ChsUserPhrase.dat');
  }

  async createBackup(target) {
    const t = target || this.targetPath;
    try {
      const stat = await fs.stat(t);
      if (!stat.isFile()) return null;
    } catch { return null; }
    const bak = `${t}.bak_undo_${Date.now()}`;
    await fs.copyFile(t, bak);
    return bak;
  }

  /**
   * 导入：同时写入三处文件，确保无论 IME 从哪个路径读取都能生效。
   *   - ChsPinyinEUDPv1.lex（mschxudp）：Settings UI「用户自定义短语」实际读取文件 —— 主目标
   *   - ChsPinyinUDL.dat（UDL）：智能短语引擎兜底
   *   - CustomPhrases/ChsUserPhrase.dat（machxudp）：旧版自定义短语位置兜底
   * @param {{ udlBuffer?:Buffer, machxudpBuffer?:Buffer, mschxudpBuffer?:Buffer, filePath?:string }} opts
   */
  async import({ udlBuffer, machxudpBuffer, mschxudpBuffer, filePath } = {}) {
    const backups = {};
    const targets = {};

    // 主目标：EUDPv1.lex（mschxudp，Settings UI 真正读取的文件）
    if (mschxudpBuffer && mschxudpBuffer.length) {
      backups.eudp = await this._writeWithBackup(this.eudpPath, mschxudpBuffer);
      targets.eudp = this.eudpPath;
    }
    // 次目标：UDL.dat（自动词库，IME 引擎兜底）
    if (udlBuffer && udlBuffer.length) {
      const udlTarget = filePath || this.targetPath;
      backups.udl = await this._writeWithBackup(udlTarget, udlBuffer);
      targets.udl = udlTarget;
    }
    // 兜底：CustomPhrases/ChsUserPhrase.dat（machxudp，旧版自定义短语位置）
    if (machxudpBuffer && machxudpBuffer.length) {
      backups.legacy = await this._writeWithBackup(this.legacyPath, machxudpBuffer);
      targets.legacy = this.legacyPath;
    }

    const reloaded = await this.reloadIme();
    return {
      target: targets.eudp || targets.udl,
      eudpTarget: targets.eudp,
      udlTarget: targets.udl,
      legacyTarget: targets.legacy,
      backupPath: backups.eudp || backups.udl,
      backups,
      reloaded,
    };
  }

  async clear({ filePath } = {}) {
    const backups = {};
    let originalCount = 0;

    // 统计原词条数（优先 EUDPv1.lex，其次 UDL）
    try {
      const buf = await fs.readFile(this.eudpPath);
      if (buf.length >= 0x24) originalCount += buf.readUInt32LE(0x1c);
    } catch {}
    if (!originalCount) {
      try {
        const buf = await fs.readFile(this.targetPath);
        if (buf.length >= 0x2400) originalCount += buf.readUInt32LE(0xc);
      } catch {}
    }

    // 1. 主目标 EUDPv1.lex 写为空（count=0）
    backups.eudp = await this._writeWithBackup(this.eudpPath, await this._buildEmptyMschxudp());
    // 2. 兜底 UDL.dat 写为空
    backups.udl = await this._writeWithBackup(this.targetPath, this._buildEmptyUdl());
    // 3. 兜底 CustomPhrases/ChsUserPhrase.dat 写为空（与导入的三处写入保持对称）
    backups.legacy = await this._writeWithBackup(this.legacyPath, this.machxudpExporter.export([]));

    const reloaded = await this.reloadIme();
    return { target: this.eudpPath, originalCount, backupPath: backups.eudp, backups, reloaded };
  }

  async undo(payload) {
    const backups = (payload && payload.backups) ? payload.backups
      : (payload && typeof payload === 'object') ? payload : null;
    if (!backups || typeof backups !== 'object') throw new Error('没有可用的备份文件');

    // 键存在 = 上次操作写过该文件：有备份则恢复；备份为 null（操作前文件不存在）则删除新写入的文件
    let touched = false;
    if ('eudp' in backups) { await this._restoreOrRemove(backups.eudp, this.eudpPath); touched = true; }
    if ('udl' in backups) { await this._restoreOrRemove(backups.udl, this.targetPath); touched = true; }
    if ('legacy' in backups) { await this._restoreOrRemove(backups.legacy, this.legacyPath); touched = true; }
    // 兼容旧 payload 形态 { backupPath }：视为主目标备份
    if (!touched && backups.backupPath) { await this._restore(backups.backupPath, this.eudpPath); touched = true; }
    if (!touched) throw new Error('没有可用的备份文件');

    const reloaded = await this.reloadIme();
    return { target: this.eudpPath, reloaded };
  }

  /** 有备份则恢复；备份为 null（操作前文件不存在）则删除目标文件，保证撤回彻底 */
  async _restoreOrRemove(backupPath, target) {
    if (backupPath) return this._restore(backupPath, target);
    try { await fs.unlink(target); } catch { /* 文件本就不存在则忽略 */ }
  }

  /** 写入文件并备份（原子：临时文件 + rename） */
  async _writeWithBackup(target, buffer) {
    const backupPath = await this.createBackup(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmpFile = `${target}.tmp_${Date.now()}`;
    await fs.writeFile(tmpFile, buffer);
    await fs.rename(tmpFile, target);
    return backupPath;
  }

  /** 从备份恢复（原子） */
  async _restore(backupPath, target) {
    if (!backupPath) return;
    try { await fs.access(backupPath); }
    catch { return; } // 备份不存在则跳过
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmpFile = `${target}.restore_${Date.now()}.tmp`;
    await fs.copyFile(backupPath, tmpFile);
    await fs.rename(tmpFile, target);
  }

  /** 构建空的 mschxudp 文件（count=0），用于清除 */
  _buildEmptyMschxudp() {
    // merge=false：清除时必须生成真正的空文件，不能把现有词条合并回来
    return this.mschxudpExporter.export([], { merge: false });
  }

  _buildEmptyUdl() {
    const buf = Buffer.alloc(0x2400, 0);
    buf.writeUInt32BE(0x55AA8881, 0);
    buf.writeUInt32LE(0x00600002, 4);
    buf.writeUInt32LE(0xAA55AA55, 8);
    buf.writeUInt32LE(0, 0xc);
    return buf;
  }

  // ══════════════════════════════════════
  // IME 重载 — 核心逻辑
  // ══════════════════════════════════════

  /**
   * 执行完整的 IME 重载流程。
   * @returns {{ killedChsIME: boolean, method: string }}
   */
  async reloadIme() {
    // Step 1: 非提升方式尝试
    let killedChsIME = false;
    let usedElevation = false;

    // 1a. 终止非特权进程（TextInputHost 等）
    await this.killProcess('TextInputHost.exe');
    await this.killProcess('Microsoft.IME.OEM.exe');

    // 1b. 尝试终止 ChsIME（可能因权限失败）
    try {
      await this.killProcess('ChsIME.exe');
      killedChsIME = true;
    } catch {
      killedChsIME = false;
    }

    await sleep(600);

    // 1c. 发送 WM_SETTINGCHANGE
    try { await this.broadcastSettingChange(); } catch {}

    // Step 2: 如果 ChsIME 未被终止，请求提升权限重载
    if (!killedChsIME) {
      const isAlive = await this.isProcessAlive('ChsIME.exe');
      if (isAlive) {
        try {
          await this.elevatedReload();
          killedChsIME = true;
          usedElevation = true;
        } catch (e) {
          // 提升权限也失败（用户拒绝了 UAC 或其他原因）
          // 返回未完全重载的状态，让 UI 提示用户
          return { killedChsIME: false, method: 'failed_elevation', error: e.message };
        }
      }
    }

    return { killedChsIME, method: killedChsIME ? (usedElevation ? 'elevated' : 'normal') : 'partial' };
  }

  /** 检查进程是否存活 */
  async isProcessAlive(name) {
    return new Promise((resolve) => {
      exec(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { timeout: 5000 }, (err, stdout) => {
        resolve(!err && stdout.includes(name));
      });
    });
  }

  /**
   * 通过提升权限的子进程执行 IME 重载。
   * 使用 PowerShell Start-Process -Verb RunAs 弹出 UAC 对话框。
   */
  async elevatedReload() {
    // 构建内联 PowerShell 命令（避免环境块过大问题，用 -EncodedCommand）
    const psCmd = [
      'Start-Sleep -Milliseconds 300;',
      'taskkill /F /IM ChsIME.exe 2>$null;',
      'Start-Sleep -Milliseconds 800;',
      'taskkill /F /IM TextInputHost.exe 2>$null;',
      'Start-Sleep -Milliseconds 500;',
      // 简单的 WM_SETTINGCHANGE（不用 Add-Type，避免环境块问题）
      '$sig = "[DllImport(`"user32.dll`")] public static extern IntPtr SM(IntPtr h,uint m,UIntPtr wp,string lp,uint f,uint t,out IntPtr r);";',
      '$t = Add-Type -MemberDefinition $sig -Name W -Namespace S -PassThru;',
      '[IntPtr]$z=0; [void]$t::SM([IntPtr]0xffff,0x1a,[UInt32]0,"Environment",2,5000,[ref]$z]);',
    ].join('');

    // Base64 编码避免引号转义问题
    const encoded = Buffer.from(psCmd, 'utf16le').toString('base64');

    return new Promise((resolve, reject) => {
      // 使用 Start-Process -Verb RunAs 请求提升权限
      const child = spawn('powershell', [
        '-NoProfile', '-WindowStyle', 'Hidden',
        '-Command', `Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle Hidden','-EncodedCommand ${encoded}' -Verb RunAs -Wait`
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      let stderr = '';
      child.stderr.on('data', (d) => stderr += d.toString());

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('UAC 提权超时（15秒无响应）'));
      }, 15000);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`提权脚本退出码 ${code}: ${stderr.slice(0, 200)}`));
      });
    });
  }

  killProcess(name) {
    return new Promise((resolve) => {
      exec(`taskkill /F /IM "${name}"`, { timeout: 5000 }, () => resolve());
    });
  }

  broadcastSettingChange() {
    return new Promise((resolve, reject) => {
      // 用 rundll32 或简单 cmd 发消息（避免 Add-Type 环境块问题）
      exec(
        `powershell -NoProfile -Command "& {$r=0};$s='[DllImport(\"\"user32\"\")]static extern IntPtr SM(IntPtr h,uint m,UIntPtr wp,string lp,uint f,uint t,out IntPtr r);';$t=Add-Type -MemberDefinition $s -Name W2 -Namespace X -PassThru;$z=0;[void]$t2::SM([IntPtr]0xffff,0x1a,[UInt32]0,'Environment',2,5000,[ref]$z)}"`,
        { timeout: 10000 },
        (err) => err ? reject(err) : resolve()
      );
    });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
