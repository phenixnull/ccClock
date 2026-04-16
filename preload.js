const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccNotify', {
  onShowNotification: (callback) => {
    ipcRenderer.on('show-notification', (_event, data) => callback(data));
  },
  dismiss: () => {
    ipcRenderer.send('dismiss');
  },
  reportHeight: (h) => {
    ipcRenderer.send('report-height', h);
  },
});
