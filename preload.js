import { contextBridge, ipcRenderer } from 'electron';

// 暴露受限 API 给渲染进程（不直接暴露 Node）
contextBridge.exposeInMainWorld('api', {
  collect: (opts) => ipcRenderer.invoke('collect', opts),
  cached: () => ipcRenderer.invoke('cached'),
  import: (payload) => ipcRenderer.invoke('import', payload),
  close: () => ipcRenderer.send('close'),
  minimize: () => ipcRenderer.send('minimize'),
});
