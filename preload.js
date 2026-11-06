const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vokaraHost', {
  openAudio: (options) => ipcRenderer.invoke('open-audio', options),
  openLyrics: () => ipcRenderer.invoke('open-lyrics'),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),
  armCapture: (kind) => ipcRenderer.invoke('capture-arm', kind),
  webOpen: (url) => ipcRenderer.invoke('web-open', url),
  webClose: () => ipcRenderer.invoke('web-close'),
  webBounds: (rect) => ipcRenderer.invoke('web-bounds', rect),
  webVisible: (visible) => ipcRenderer.invoke('web-visible', visible),
  webCommand: (command) => ipcRenderer.invoke('web-command', command),
  webMedia: (action) => ipcRenderer.invoke('web-media', action),
  onWebState: (listener) => ipcRenderer.on('web-state', (_event, state) => listener(state)),
  onWebError: (listener) => ipcRenderer.on('web-error', (_event, error) => listener(error)),
});
