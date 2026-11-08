'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('store:load'),
  saveData: (data) => ipcRenderer.invoke('store:save', data),
  saveDataSync: (data) => ipcRenderer.sendSync('store:saveSync', data),
  dataPath: () => ipcRenderer.invoke('store:path'),
  exportJson: (defaultName, data) => ipcRenderer.invoke('dialog:saveJson', { defaultName, data }),
  importJson: () => ipcRenderer.invoke('dialog:openJson'),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  saveResponse: (defaultName, base64) => ipcRenderer.invoke('dialog:saveResponse', { defaultName, base64 }),
  send: (spec) => ipcRenderer.invoke('http:send', spec),
  cancel: (id) => ipcRenderer.invoke('http:cancel', id),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, channel) => cb(channel)),
});
