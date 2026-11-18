import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Result } from '@shared/types'
import type { AbiApi, SystemTheme } from '../../preload/api'

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<Result<T>> {
  try {
    return await invoke<Result<T>>(cmd, args)
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'unknown',
        title: 'Ошибка взаимодействия с ядром',
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

function subscribe<T>(eventName: string, cb: (payload: T) => void): () => void {
  let cancelled = false
  let unlistenFn: (() => void) | null = null
  void listen<T>(eventName, (ev) => {
    if (!cancelled) cb(ev.payload)
  })
    .then((fn) => {
      if (cancelled) {
        fn()
      } else {
        unlistenFn = fn
      }
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
    if (unlistenFn) unlistenFn()
  }
}

if (typeof window !== 'undefined' && !window.abi) {
  const api: AbiApi = {
    getAppInfo: () => call('app_info'),
    getSettings: () => call('settings_get'),
    updateSettings: (patch) => call('settings_update', { patch }),
    pickDirectory: (defaultPath) =>
      call('dialog_pick_directory', { defaultPath: defaultPath ?? null }),
    pickJavaExecutable: () => call('dialog_pick_java'),

    getSystemTheme: () => call<SystemTheme>('theme_get_system'),
    onSystemThemeChanged: (cb) => {
      const unsubTauri = subscribe<SystemTheme>('theme:changed', cb)
      const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
      const onMedia = () => cb(mq.matches ? 'dark' : 'light')
      mq?.addEventListener?.('change', onMedia)
      return () => {
        unsubTauri()
        mq?.removeEventListener?.('change', onMedia)
      }
    },

    windowMinimize: () => call('window_minimize'),
    windowToggleMaximize: () => call('window_toggle_maximize'),
    windowClose: () => call('window_close'),
    windowIsMaximized: () => call('window_is_maximized'),
    onWindowMaximizedChanged: (cb) => subscribe('window:maximized', cb),

    getProfiles: () => call('profiles_get'),
    createProfile: (name) => call('profiles_create', { name }),
    renameProfile: (id, name) => call('profiles_rename', { id, name }),
    deleteProfile: (id) => call('profiles_delete', { id }),
    selectProfile: (id) => call('profiles_select', { id }),

    loadCatalog: () => call('catalog_load'),
    addCustomRepo: (repoInput, branch) =>
      call('catalog_add_repo', { repoInput, branch: branch ?? null }),
    removeCustomRepo: (repo) => call('catalog_remove_repo', { repo }),

    checkPack: (packKey) => call('pack_check', { packKey }),
    installPack: (packKey, resolutions) =>
      call('pack_install', { packKey, resolutions: resolutions ?? null }),
    playPack: (packKey, options) =>
      call('pack_play', { packKey, options: options ?? null }),
    cancelOperation: (packKey) => call('pack_cancel', { packKey }),

    openInstanceFolder: (packKey, subfolder) =>
      call('pack_open_folder', { packKey, subfolder: subfolder ?? null }),
    getLatestCrashReport: (packKey) => call('pack_latest_crash_report', { packKey }),
    listJava: () => call('java_list'),
    testJava: (javaPath) => call('java_test', { javaPath }),

    pingServer: (host, port) => call('server_ping', { host, port: port ?? null }),
    loadNews: () => call('news_load'),

    getLogs: () => call('logs_get'),
    onLog: (cb) => subscribe('logs:entry', cb),
    exportDiagnostics: () => call('diagnostics_export'),

    getLauncherUpdateState: () => call('launcher_update_get_state'),
    checkLauncherUpdate: () => call('launcher_update_check'),
    downloadLauncherUpdate: () => call('launcher_update_download'),
    cancelLauncherUpdateDownload: () => call('launcher_update_cancel_download'),
    installLauncherUpdate: () => call('launcher_update_install'),
    openLauncherReleasePage: () => call('launcher_update_open_release_page'),
    onLauncherUpdateState: (cb) => subscribe('launcherUpdate:state', cb),

    onProgress: (cb) => subscribe('pack:progress', cb),
    onPackState: (cb) => subscribe('pack:state', cb),
    onGameEvent: (cb) => subscribe('game:event', cb)
  }

  window.abi = api
}
