import { ImeImporter } from '../../interfaces/ImeImporter.js';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import path from 'path';

// 写入 %APPDATA%\Microsoft\InputMethod\Chs\CustomPhrases\ChsUserPhrase.dat
// 并尝试结束输入法进程以触发重新加载（best-effort，真机验证）。
export class MsPinyinImporter extends ImeImporter {
  constructor() {
    super();
    this.defaultDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Microsoft', 'InputMethod', 'Chs', 'CustomPhrases')
      : '';
    this.defaultFile = 'ChsUserPhrase.dat';
  }

  get targetPath() { return path.join(this.defaultDir, this.defaultFile); }

  async import(datBuffer, { filePath } = {}) {
    const target = filePath || this.targetPath;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, datBuffer);
    await this.reloadIme();
    return target;
  }

  reloadIme() {
    return new Promise((resolve) => {
      // 进程名因 Windows 版本而异；结束后面板/输入法通常会自动重启并重新加载词库
      exec('taskkill /F /IM ChsIME.exe 2>nul & taskkill /F /IM Microsoft.IME.OEM.exe 2>nul & taskkill /F /IM TextInputHost.exe 2>nul',
        () => resolve());
    });
  }
}
