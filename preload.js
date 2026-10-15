const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  savePhoto: (dataUrl) => ipcRenderer.invoke('save-photo', dataUrl),

  openSettings: () => ipcRenderer.invoke('open-settings'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  getPaperPresets: () => ipcRenderer.invoke('config:papers'),
  onConfigUpdated: (callback) => {
    ipcRenderer.on('config:updated', (event, config) => callback(config));
  },

  savePreset: (name) => ipcRenderer.invoke('presets:save', name),
  loadPreset: (name) => ipcRenderer.invoke('presets:load', name),
  deletePreset: (name) => ipcRenderer.invoke('presets:delete', name),

  saveEvent: (payload) => ipcRenderer.invoke('events:save', payload),
  deleteEvent: (name) => ipcRenderer.invoke('events:delete', name),
  startEvent: (name) => ipcRenderer.invoke('events:start', name),
  endEvent: () => ipcRenderer.invoke('events:end'),

  chooseTemplate: () => ipcRenderer.invoke('template:choose'),
  readTemplate: (path) => ipcRenderer.invoke('template:read', path),

  listPrinters: () => ipcRenderer.invoke('printers:list'),

  enqueuePrint: (payload) => ipcRenderer.invoke('print:enqueue', payload),
  retryPrint: (jobId) => ipcRenderer.invoke('print:retry', jobId),
  getPrintSnapshot: () => ipcRenderer.invoke('print:snapshot'),
  onPrintQueueUpdate: (callback) => {
    ipcRenderer.on('print-queue:update', (event, jobs) => callback(jobs));
  },

  saveOriginalPhoto: (dataUrl) => ipcRenderer.invoke('photo:save-original', dataUrl),
  readPhotoAsDataUrl: (filePath) => ipcRenderer.invoke('photo:read-as-dataurl', filePath),

  chooseDslrFolder: () => ipcRenderer.invoke('dslr:choose-folder'),
  chooseDslrRemoteCmd: () => ipcRenderer.invoke('dslr:choose-remote-cmd'),
  getDslrBundledStatus: () => ipcRenderer.invoke('dslr:bundled-status'),
  dslrLiveStart: () => ipcRenderer.invoke('dslr:live-start'),
  dslrLiveShow: () => ipcRenderer.invoke('dslr:live-show'),
  triggerDslrCapture: () => ipcRenderer.invoke('dslr:trigger-capture'),
  onDslrPhotoCaptured: (callback) => {
    ipcRenderer.on('dslr:photo-captured', (event, filePath) => callback(filePath));
  },

  sharePhoto: (filePath) => ipcRenderer.invoke('share:photo', filePath),
  getShareStatus: () => ipcRenderer.invoke('share:status'),

  activateLicense: (payload) => ipcRenderer.invoke('license:activate', payload),
  getLicenseStatus: () => ipcRenderer.invoke('license:status'),
  getDeviceId: () => ipcRenderer.invoke('license:deviceId'),

  openLogFolder: () => ipcRenderer.invoke('diagnostics:open-log-folder'),
  getSystemInfo: () => ipcRenderer.invoke('diagnostics:system-info'),
  getStartupTime: () => ipcRenderer.invoke('diagnostics:startup-time')
});