const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccNotify', {
  onShowNotification: (callback) => {
    ipcRenderer.on('show-notification', (_event, data) => callback(data));
  },
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', (_event, settings) => callback(settings));
  },
  onLayoutChanged: (callback) => {
    ipcRenderer.on('layout-changed', (_event, constraints) => callback(constraints));
  },
  onNotificationVisibility: (callback) => {
    ipcRenderer.on('notification-visibility', (_event, state) => callback(state));
  },
  setDefaultSoundEnabled: (enabled) => {
    return ipcRenderer.invoke('set-default-sound', enabled);
  },
  dismiss: () => {
    ipcRenderer.send('dismiss');
  },
  reportCardState: (state) => {
    ipcRenderer.send('card-state', state);
  },
  reportHeight: (h, revision) => {
    ipcRenderer.send('report-height', h, revision);
  },
});
