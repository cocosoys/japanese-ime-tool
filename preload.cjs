// Preload（CJS）—— Electron preload 加载器只支持 CommonJS
const { contextBridge, ipcRenderer } = require('electron');

// 暴露受限 API 给渲染进程（不直接暴露 Node）
contextBridge.exposeInMainWorld('api', {
  collect: (opts) => ipcRenderer.invoke('collect', opts),
  autoCf: (opts) => ipcRenderer.invoke('auto-cf', opts),
  collectFromHtml: (payload) => ipcRenderer.invoke('collect-from-html', payload),
  cached: () => ipcRenderer.invoke('cached'),
  import: (payload) => ipcRenderer.invoke('import', payload),
  clearIme: () => ipcRenderer.invoke('clear-ime'),
  undoIme: (payload) => ipcRenderer.invoke('undo-ime', payload),
  resolveOrders: (payload) => ipcRenderer.invoke('resolve-orders', payload),
  batches: () => ipcRenderer.invoke('batches'),
  loadBatch: (payload) => ipcRenderer.invoke('batch-load', payload),
  saveUsed: (payload) => ipcRenderer.invoke('used-save', payload),
  loadConfig: () => ipcRenderer.invoke('config-load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config-save', cfg),
  close: () => ipcRenderer.send('close'),
  minimize: () => ipcRenderer.send('minimize'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  copyText: (payload) => ipcRenderer.invoke('copy-text', payload),
});
