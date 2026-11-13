const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('audit', { report: (r) => ipcRenderer.invoke('report', r), metrics: () => ipcRenderer.invoke('metrics') });
