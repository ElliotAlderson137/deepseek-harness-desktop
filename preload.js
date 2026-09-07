'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  getState: () => ipcRenderer.invoke('get-state'),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_e, s) => cb(s)),
  onServerReady: (cb) => ipcRenderer.on('server-ready', (_e, info) => cb(info))
});
