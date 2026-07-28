// Preload（CJS）—— Electron preload 加载器只支持 CommonJS
const { contextBridge, ipcRenderer } = require('electron');

// 暴露受限 API 给渲染进程（不直接暴露 Node）
contextBridge.exposeInMainWorld('api', {
  collect: (opts) => ipcRenderer.invoke('collect', opts),
  autoCf: (opts) => ipcRenderer.invoke('auto-cf', opts),
  collectFromHtml: (payload) => ipcRenderer.invoke('collect-from-html', payload),
  cached: () => ipcRenderer.invoke('cached'),
  import: (payload) => ipcRenderer.invoke('import', payload),
  loadConfig: () => ipcRenderer.invoke('config-load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config-save', cfg),
  close: () => ipcRenderer.send('close'),
  minimize: () => ipcRenderer.send('minimize'),
});
