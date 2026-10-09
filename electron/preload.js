'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  get: (store, id) => ipcRenderer.invoke('db:get', store, id),
  put: (store, value) => ipcRenderer.invoke('db:put', store, value),
  all: (store) => ipcRenderer.invoke('db:all', store),
  del: (store, id) => ipcRenderer.invoke('db:del', store, id),
  putAsset: (bytes, ext) => ipcRenderer.invoke('asset:put', bytes, ext),
  getAsset: (id) => ipcRenderer.invoke('asset:get', id),
  snip: (rect) => ipcRenderer.invoke('snip', rect),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  info: () => ipcRenderer.invoke('info'),
  webGet: (url, kind, jobId) => ipcRenderer.invoke('web:get', url, kind, jobId),
  onWebProgress: (fn) => ipcRenderer.on('web:progress', (_e, id, got, total) => fn(id, got, total)),
  webTitle: (url) => ipcRenderer.invoke('web:title', url),
  gd: {
    status: () => ipcRenderer.invoke('gd:status'),
    config: (c) => ipcRenderer.invoke('gd:config', c),
    cardsAvailable: (n) => ipcRenderer.invoke('gd:cardsAvailable', n),
    breakNow: () => ipcRenderer.invoke('gd:breakNow'),
    done: () => ipcRenderer.invoke('gd:done'),
    modInfo: () => ipcRenderer.invoke('gd:modInfo'),
    installMod: (fromDialog) => ipcRenderer.invoke('gd:installMod', fromDialog),
    onStatus: (fn) => ipcRenderer.on('gd:status', (_e, s) => fn(s)),
    onGate: (fn) => ipcRenderer.on('gate:start', (_e, s) => fn(s)),
  },
  onFlush: (fn) => ipcRenderer.on('flush', async () => {
    try { await fn(); } finally { ipcRenderer.send('flushed'); }
  }),
});
