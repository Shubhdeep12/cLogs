'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('netlog', {
  platform: process.platform,
  state: () => ipcRenderer.invoke('state'),
  start: () => ipcRenderer.invoke('rec:start'),
  stop: () => ipcRenderer.invoke('rec:stop'),
  clear: () => ipcRenderer.invoke('rec:clear'),
  openView: (key) => ipcRenderer.invoke('view:open', key),
  closeView: () => ipcRenderer.invoke('view:close'),
  getDetail: (key, id) => ipcRenderer.invoke('call:detail', key, id),
  exportHar: (scope) => ipcRenderer.invoke('har:export', scope),
  importHar: () => ipcRenderer.invoke('har:import'),
  removeImport: (id) => ipcRenderer.invoke('har:remove', id),
  listRoots: () => ipcRenderer.invoke('roots:list'),
  addRoot: () => ipcRenderer.invoke('roots:add'),
  removeRoot: (dir) => ipcRenderer.invoke('roots:remove', dir),
  toggleRoot: (dir, on) => ipcRenderer.invoke('roots:toggle', dir, on),
  reveal: (key) => ipcRenderer.invoke('file:reveal', key),
  onState: on('state'),
  onViewUpdate: on('view:update'),
  onMenu: on('menu'),
});
