const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform:            process.platform,
  charList:            ()     => ipcRenderer.invoke('char:list'),
  charThumb:           (name) => ipcRenderer.invoke('char:thumb', name),
  charTags:            ()     => ipcRenderer.invoke('char:tags'),
  charThumbsReady:     ()     => ipcRenderer.invoke('char:thumbsReady'),
  configGet:           ()     => ipcRenderer.invoke('config:get'),
  configPickDataFolder:()     => ipcRenderer.invoke('config:pickDataFolder'),
  onUpdateAvailable:    (cb)  => ipcRenderer.on('update-available', (_, v) => cb(v)),

  // Process launcher (SwarmUI, Forge, …) — key selects the config.json field
  pickLaunchScript:     (key, title, message) => ipcRenderer.invoke('launcher:pickScript', key, title, message),
  launchProcess:        (key, args)           => ipcRenderer.invoke('launcher:launch', key, args),

  // Model downloads
  pickModelsFolder:     ()         => ipcRenderer.invoke('models:pickFolder'),
  downloadModel:        (url, dst) => ipcRenderer.invoke('models:download', { url, destPath: dst }),
  onModelProgress:      (cb)       => ipcRenderer.on('models:progress', (_, d) => cb(d)),
  removeModelProgress:  ()         => ipcRenderer.removeAllListeners('models:progress'),
});
