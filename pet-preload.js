'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  dragStart: (x, y) => ipcRenderer.send('pet-drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('pet-drag-move', { x, y }),
  clicked: () => ipcRenderer.send('pet-clicked'),
  onSay: (cb) => ipcRenderer.on('pet-say', (_e, msg) => cb(msg)),
  onState: (cb) => ipcRenderer.on('pet-state', (_e, s) => cb(s)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet-set-ignore-mouse', ignore),
});
