const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform:            process.platform,
  charList:            ()     => ipcRenderer.invoke('char:list'),
  charThumb:           (name) => ipcRenderer.invoke('char:thumb', name),
  charTags:            ()     => ipcRenderer.invoke('char:tags'),
  charThumbsReady:     ()     => ipcRenderer.invoke('char:thumbsReady'),
  configGet:           ()     => ipcRenderer.invoke('config:get'),
  configPickDataFolder:()     => ipcRenderer.invoke('config:pickDataFolder'),
  onUpdateAvailable:   (cb)  => ipcRenderer.on('update-available', (_, v) => cb(v)),
});
