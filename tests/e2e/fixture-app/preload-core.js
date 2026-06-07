'use strict';
/**
 * The fixture's OWN preload (stands in for GeoGebra's preload.js). It exposes a
 * trivial `window.ipc` bridge — exactly like GeoGebra's. Our proxy must chain
 * this, so after injection BOTH window.ipc AND window.ggbExtendHost exist.
 */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ipc', {
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
});
contextBridge.exposeInMainWorld('__fixturePreloadRan', true);
