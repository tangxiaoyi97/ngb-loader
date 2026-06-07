'use strict';

// Secure bridge: exposes a typed `window.ggbx` API over contextBridge
// (contextIsolation on, no Node in the renderer). Every call returns
// { ok, data } | { ok:false, error }.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ggbx', {
  scan: () => invoke('ggbx:scan'),
  list: () => invoke('ggbx:list'),
  add: (path) => invoke('ggbx:add', path),
  remove: (id, opts) => invoke('ggbx:remove', id, opts),
  inject: (id, opts) => invoke('ggbx:inject', id, opts),
  restore: (id, opts) => invoke('ggbx:restore', id, opts),
  listPlugins: (ggbId) => invoke('ggbx:listPlugins', ggbId),
  setPlugin: (ggbId, pluginId, enabled) => invoke('ggbx:setPlugin', ggbId, pluginId, enabled),
  openPluginsFolder: () => invoke('ggbx:openPluginsFolder'),
  addPlugin: () => invoke('ggbx:addPlugin'),
  openExternal: (url) => invoke('ggbx:openExternal', url),
  openTerminal: () => invoke('ggbx:openTerminal'),
  appInfo: () => invoke('ggbx:appInfo'),
  launch: (id, opts) => invoke('ggbx:launch', id, opts),
  getSettings: () => invoke('ggbx:getSettings'),
  setSettings: (patch) => invoke('ggbx:setSettings', patch),
  pickApp: () => invoke('ggbx:pickApp'),
  pickFolder: () => invoke('ggbx:pickFolder'),
  openPath: (p) => invoke('ggbx:openPath', p),
  // live log stream from inject/restore
  onLog: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('ggbx:log', handler);
    return () => ipcRenderer.removeListener('ggbx:log', handler);
  },
});
