const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccNotify', {
  onShowNotification: (callback) => {
    ipcRenderer.on('show-notification', (_event, data) => callback(data));
  },
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', (_event, settings) => callback(settings));
  },
  setDefaultSoundEnabled: (enabled) => {
    return ipcRenderer.invoke('set-default-sound', enabled);
  },
  dismiss: () => {
    ipcRenderer.send('dismiss');
  },
  reportHeight: (h) => {
    ipcRenderer.send('report-height', h);
  },
});
