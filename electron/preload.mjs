import { contextBridge, ipcRenderer } from 'electron';

// Expose a tiny, explicit API for desktop-only features.
contextBridge.exposeInMainWorld('smDesktop', {
  isElectron: true,
  setConfig: (config) => ipcRenderer.invoke('sm:set-config', config),
  setNotificationsEnabled: (enabled) => ipcRenderer.invoke('sm:set-notifications-enabled', Boolean(enabled)),
});

