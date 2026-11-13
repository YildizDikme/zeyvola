// Lets the test pattern report its clicks and flashes to the harness.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('patternBridge', { log: (e) => ipcRenderer.send('pattern', e) });
