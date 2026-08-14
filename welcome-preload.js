'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('welcomeAPI', {
  openUrl: (url) => ipcRenderer.send('welcome-open-url', url),
  done: () => ipcRenderer.send('welcome-done'),
});
