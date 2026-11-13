// Lets the test pattern report its events; adds the mouse button to clicks.
const { contextBridge, ipcRenderer } = require('electron');
let button = 0;
window.addEventListener('mousedown', (e) => { button = e.button; }, true);
window.addEventListener('contextmenu', (e) => e.preventDefault());
contextBridge.exposeInMainWorld('patternBridge', { log: (e) => ipcRenderer.send('pattern', e.type === 'click' ? { ...e, button } : e) });
