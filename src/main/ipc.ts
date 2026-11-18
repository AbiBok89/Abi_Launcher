import { writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, nativeTheme, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { LauncherError, toUserError } from '@core/errors'
import { ensureDir } from '@core/fsutil'
import type { LauncherService } from '@core/launcherService'
import { LAUNCHER_RELEASES_PAGE_URL, type LauncherUpdater } from '@core/launcherUpdater'
import { logger } from '@core/log'
import type { Result, Settings } from '@shared/types'

const PackKeySchema = z.string().regex(/^[A-Za-z0-9._-]{1,200}$/)
const SubfolderSchema = z.enum(['root', 'mods', 'screenshots', 'crash-reports', 'logs']).optional()
const JvmArgsSchema = z
  .string()
  .max(2000)
  .refine((v) => !/[\r\n\0]/.test(v), 'Аргументы JVM не должны содержать переносы строк')
const ConflictChoiceSchema = z.enum(['replace', 'keep'])
const ResolutionsSchema = z.record(z.string().max(450), ConflictChoiceSchema).optional()

const SettingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    installDir: z.string().min(1).max(1024).optional(),
    catalogUrl: z.string().max(2048).optional(),
    defaultMemoryMb: z.number().int().min(1024).max(65536).nullable().optional(),
    javaPath: z.string().max(1024).nullable().optional(),
    resolution: z
      .object({
        width: z.number().int().min(640).max(7680).optional(),
        height: z.number().int().min(480).max(4320).optional(),
        fullscreen: z.boolean().optional()
      })
      .optional(),
    afterLaunch: z.enum(['keep', 'minimize', 'hide', 'close']).optional(),
    fullVerifyOnLaunch: z.boolean().optional(),
    autoJoinServer: z.boolean().optional(),
    extraJvmArgs: JvmArgsSchema.optional(),
    autoCheckLauncherUpdates: z.boolean().optional(),
    packOverrides: z
      .record(
        PackKeySchema,
        z.object({
          memoryMb: z.number().int().min(1024).max(65536).nullable().optional(),
          javaPath: z.string().max(1024).nullable().optional(),
          extraJvmArgs: JvmArgsSchema.nullable().optional()
        })
      )
      .optional()
  })
  .strict()

const HostSchema = z.string().regex(/^[A-Za-z0-9.-]{1,253}$/)
const PortSchema = z.number().int().min(1).max(65535).optional()

function assertSenderIsMainFrame(event: IpcMainInvokeEvent, win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame) {
    throw new LauncherError('unknown', 'Доступ запрещён', 'Запрос отклонён проверкой источника IPC.')
  }
}

export function registerIpcHandlers(
  service: LauncherService,
  updater: LauncherUpdater,
  getWindow: () => BrowserWindow | null
): () => void {
  const registeredChannels: string[] = []

  function handle<T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
      try {
        assertSenderIsMainFrame(event, getWindow())
        const value = await fn(event, ...args)
        return { ok: true, value }
      } catch (e) {
        return { ok: false, error: toUserError(e) }
      }
    })
  }

  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    totalMemoryMb: Math.floor(totalmem() / (1024 * 1024)),
    userDataDir: app.getPath('userData'),
    defaultInstallDir: join(app.getPath('userData'), 'gamedata')
  }))

  handle('settings:get', () => service.getSettings())

  handle('settings:update', async (_ev, rawPatch) => {
    const parsed = SettingsPatchSchema.parse(rawPatch)
    const patch: Partial<Settings> = {
      ...parsed,
      resolution: parsed.resolution
        ? ({
            ...(await service.getSettings()).resolution,
            ...parsed.resolution
          })
        : undefined
    }
    return service.updateSettings(patch)
  })

  handle('dialog:pickDirectory', async (_ev, rawDefault) => {
    const win = getWindow()
    if (!win) return null
    const defaultPath = typeof rawDefault === 'string' && rawDefault.length <= 1024 ? rawDefault : undefined
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите папку установки сборок',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  handle('dialog:pickJava', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: process.platform === 'win32' ? 'Выберите java.exe' : 'Выберите исполняемый файл java',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java (java.exe)', extensions: ['exe'] }]
          : undefined
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  handle('theme:getSystem', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))

  handle('window:minimize', () => {
    getWindow()?.minimize()
  })
  handle('window:toggleMaximize', () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle('window:close', () => {
    getWindow()?.close()
  })
  handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

  handle('profiles:get', () => service.getProfiles())
  handle('profiles:create', (_ev, name) => service.createProfile(z.string().min(1).max(32).parse(name)))
  handle('profiles:rename', (_ev, id, name) =>
    service.renameProfile(z.string().min(1).max(80).parse(id), z.string().min(1).max(32).parse(name))
  )
  handle('profiles:delete', (_ev, id) => service.deleteProfile(z.string().min(1).max(80).parse(id)))
  handle('profiles:select', (_ev, id) => service.selectProfile(z.string().min(1).max(80).parse(id)))

  handle('catalog:load', () => service.loadCatalog())
  handle('catalog:addRepo', (_ev, input, branch) =>
    service.addCustomRepo(
      z.string().min(1).max(500).parse(input),
      z.string().max(100).optional().parse(branch)
    )
  )
  handle('catalog:removeRepo', (_ev, repo) =>
    service.removeCustomRepo(z.string().min(1).max(200).parse(repo))
  )

  handle('pack:check', (_ev, packKey) => service.checkPack(PackKeySchema.parse(packKey)))
  handle('pack:install', (_ev, packKey, resolutions) =>
    service.installPack(PackKeySchema.parse(packKey), ResolutionsSchema.parse(resolutions) ?? {})
  )
  handle('pack:play', (_ev, packKey, options) => {
    const parsedOpts = z
      .object({
        resolutions: ResolutionsSchema,
        joinServer: z.boolean().optional()
      })
      .optional()
      .parse(options)
    return service.playPack(PackKeySchema.parse(packKey), parsedOpts ?? {})
  })
  handle('pack:cancel', (_ev, packKey) => service.cancelOperation(PackKeySchema.parse(packKey)))

  handle('pack:openFolder', async (_ev, packKey, rawSubfolder) => {
    const key = PackKeySchema.parse(packKey)
    const subfolder = SubfolderSchema.parse(rawSubfolder)
    const settings = await service.getSettings()
    const baseDir = service.getInstanceDir(settings.installDir, key)
    const targetDir = subfolder && subfolder !== 'root' ? join(baseDir, subfolder) : baseDir
    await ensureDir(targetDir)
    const err = await shell.openPath(targetDir)
    if (err) throw new LauncherError('filesystem', 'Не удалось открыть папку', err)
    return true
  })

  handle('pack:latestCrashReport', (_ev, packKey) =>
    service.getLatestCrashReport(PackKeySchema.parse(packKey))
  )

  handle('launcherUpdate:getState', () => updater.getState())
  handle('launcherUpdate:check', () => updater.checkForUpdates())
  handle('launcherUpdate:download', () => updater.downloadUpdate())
  handle('launcherUpdate:cancelDownload', () => {
    updater.cancelDownload()
    return true
  })
  handle('launcherUpdate:install', () => updater.installDownloadedUpdate())
  handle('launcherUpdate:openReleasePage', async () => {
    const raw = updater.getState().releaseUrl ?? LAUNCHER_RELEASES_PAGE_URL
    const safeUrl = raw.startsWith('https://github.com/AbiBok89/Abi_Launcher/')
      ? raw
      : LAUNCHER_RELEASES_PAGE_URL
    await shell.openExternal(safeUrl)
    return true
  })

  handle('java:list', () => service.listJava())
  handle('java:test', (_ev, javaPath) => service.testJava(z.string().min(1).max(1024).parse(javaPath)))

  handle('server:ping', (_ev, host, port) =>
    service.pingServer(HostSchema.parse(host), PortSchema.parse(port))
  )
  handle('news:load', () => service.loadNews())

  handle('logs:get', () => logger.entries())

  handle('diagnostics:export', async () => {
    const win = getWindow()
    if (!win) return null
    const saveRes = await dialog.showSaveDialog(win, {
      title: 'Сохранить диагностический отчёт AbiLauncher',
      defaultPath: `abilauncher-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (saveRes.canceled || !saveRes.filePath) return null
    const content = await service.exportDiagnostics({
      launcher: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node
    })
    await writeFile(saveRes.filePath, content, 'utf8')
    return saveRes.filePath
  })

  // Подписка на поток событий ядра в окно renderer
  const unsubProgress = service.onProgress((ev) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('pack:progress', ev)
  })
  const unsubState = service.onPackState((ev) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('pack:state', ev)
  })
  const unsubGame = service.onGameEvent((ev) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('game:event', ev)
  })
  const unsubLogs = logger.onEntry((entry) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('logs:entry', entry)
  })
  const unsubUpdater = updater.onState((state) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('launcherUpdate:state', state)
  })

  const onThemeUpdated = () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    }
  }
  nativeTheme.on('updated', onThemeUpdated)

  return () => {
    for (const ch of registeredChannels) ipcMain.removeHandler(ch)
    unsubProgress()
    unsubState()
    unsubGame()
    unsubLogs()
    unsubUpdater()
    nativeTheme.removeListener('updated', onThemeUpdated)
  }
}
