import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AbiApi } from './api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AbiApi = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  pickDirectory: (defaultPath) => ipcRenderer.invoke('dialog:pickDirectory', defaultPath),
  pickJavaExecutable: () => ipcRenderer.invoke('dialog:pickJava'),

  getSystemTheme: () => ipcRenderer.invoke('theme:getSystem'),
  onSystemThemeChanged: (cb) => subscribe('theme:changed', cb),

  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizedChanged: (cb) => subscribe('window:maximized', cb),

  getProfiles: () => ipcRenderer.invoke('profiles:get'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  selectProfile: (id) => ipcRenderer.invoke('profiles:select', id),

  loadCatalog: () => ipcRenderer.invoke('catalog:load'),
  addCustomRepo: (repoInput, branch) => ipcRenderer.invoke('catalog:addRepo', repoInput, branch),
  removeCustomRepo: (repo) => ipcRenderer.invoke('catalog:removeRepo', repo),

  checkPack: (packKey) => ipcRenderer.invoke('pack:check', packKey),
  installPack: (packKey, resolutions) => ipcRenderer.invoke('pack:install', packKey, resolutions),
  playPack: (packKey, options) => ipcRenderer.invoke('pack:play', packKey, options),
  cancelOperation: (packKey) => ipcRenderer.invoke('pack:cancel', packKey),

  openInstanceFolder: (packKey, subfolder) => ipcRenderer.invoke('pack:openFolder', packKey, subfolder),
  getLatestCrashReport: (packKey) => ipcRenderer.invoke('pack:latestCrashReport', packKey),
  listJava: () => ipcRenderer.invoke('java:list'),
  testJava: (javaPath) => ipcRenderer.invoke('java:test', javaPath),

  pingServer: (host, port) => ipcRenderer.invoke('server:ping', host, port),
  loadNews: () => ipcRenderer.invoke('news:load'),

  getLogs: () => ipcRenderer.invoke('logs:get'),
  onLog: (cb) => subscribe('logs:entry', cb),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),

  getLauncherUpdateState: () => ipcRenderer.invoke('launcherUpdate:getState'),
  checkLauncherUpdate: () => ipcRenderer.invoke('launcherUpdate:check'),
  downloadLauncherUpdate: () => ipcRenderer.invoke('launcherUpdate:download'),
  cancelLauncherUpdateDownload: () => ipcRenderer.invoke('launcherUpdate:cancelDownload'),
  installLauncherUpdate: () => ipcRenderer.invoke('launcherUpdate:install'),
  openLauncherReleasePage: () => ipcRenderer.invoke('launcherUpdate:openReleasePage'),
  onLauncherUpdateState: (cb) => subscribe('launcherUpdate:state', cb),

  onProgress: (cb) => subscribe('pack:progress', cb),
  onPackState: (cb) => subscribe('pack:state', cb),
  onGameEvent: (cb) => subscribe('game:event', cb)
}

contextBridge.exposeInMainWorld('abi', api)
