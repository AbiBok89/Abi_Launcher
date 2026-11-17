import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { LauncherService } from '@core/launcherService'
import { logger } from '@core/log'
import { registerIpcHandlers } from './ipc'

const log = logger.scope('main')

let mainWindow: BrowserWindow | null = null
let service: LauncherService | null = null
let quitWhenGameExits = false
let gameRunningCount = 0

function isDevRendererUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl) return false
  try {
    return new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

function installSecurityHeaders(): void {
  const devOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null
  const devWs = devOrigin ? devOrigin.replace(/^http/, 'ws') : null

  const csp = devOrigin
    ? `default-src 'self' ${devOrigin}; script-src 'self' 'unsafe-inline' ${devOrigin}; style-src 'self' 'unsafe-inline' ${devOrigin}; img-src 'self' data: ${devOrigin}; font-src 'self' data: ${devOrigin}; connect-src 'self' ${devOrigin} ${devWs}; object-src 'none'; frame-src 'none'; base-uri 'none'`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'`

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'AbiLauncher',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1117' : '#f4f6fa',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isDevRendererUrl(url) && !url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData')
  logger.setFile(join(userDataDir, 'logs', 'launcher.log'))
  log.info(`Запуск AbiLauncher v${app.getVersion()} (${process.platform}/${process.arch})`)

  installSecurityHeaders()
  service = new LauncherService(userDataDir)

  service.onGameEvent(async (ev) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (ev.state === 'exited' && quitWhenGameExits) app.quit()
      return
    }
    const settings = await service!.getSettings().catch(() => null)
    if (!settings) return

    if (ev.state === 'started') {
      gameRunningCount++
      if (settings.afterLaunch === 'minimize') {
        mainWindow.minimize()
      } else if (settings.afterLaunch === 'hide') {
        mainWindow.hide()
      } else if (settings.afterLaunch === 'close') {
        quitWhenGameExits = true
        mainWindow.setSkipTaskbar(true)
        mainWindow.hide()
      }
    } else if (ev.state === 'exited') {
      gameRunningCount = Math.max(0, gameRunningCount - 1)
      if (quitWhenGameExits && gameRunningCount === 0) {
        app.quit()
        return
      }
      if (settings.afterLaunch === 'hide' || settings.afterLaunch === 'minimize') {
        if (mainWindow.isMinimized()) mainWindow.restore()
        if (!mainWindow.isVisible()) mainWindow.show()
        mainWindow.focus()
      }
    }
  })

  registerIpcHandlers(service, () => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow && !mainWindow.isVisible() && !quitWhenGameExits) {
      mainWindow.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !quitWhenGameExits) {
    app.quit()
  }
})
