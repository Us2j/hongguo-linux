// CommonJS preload（sandbox=true 下不支持 ESM preload）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  feed: (page = 0, genre = null) => ipcRenderer.invoke('feed', { page, genre }),
  search: (query, page = 0) => ipcRenderer.invoke('search', query, page),
  webSearch: (query) => ipcRenderer.invoke('websearch', query),
  prewarmWebSearch: () => ipcRenderer.invoke('websearch:prewarm'),
  episodes: (seriesId) => ipcRenderer.invoke('episodes', seriesId),
  prepare: (vid) => ipcRenderer.invoke('prepare', vid),
  cancel: (vid) => ipcRenderer.invoke('cancel', vid),
  listIdentities: () => ipcRenderer.invoke('identity:list'),
  useIdentity: (name) => ipcRenderer.invoke('identity:use', name),
});
