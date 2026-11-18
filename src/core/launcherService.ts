import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CatalogResult,
  ConflictChoice,
  CrashReportView,
  GameEvent,
  JavaInfoView,
  NewsResult,
  PackStateEvent,
  PackStatus,
  PackView,
  ProfilesState,
  ProgressEvent,
  ServerStatus,
  Settings
} from '@shared/types'
import { isAllowedUrl, type Manifest, type PackInfo } from '@shared/schemas'
import { CatalogRequestOptions, CatalogService, saveLocalPackMeta } from './catalogService'
import { buildDiagnosticsReport } from './diagnostics'
import { LauncherError, isAbortError, toUserError } from './errors'
import { ensureDir } from './fsutil'
import { launchGame } from './gameLauncher'
import { parseRepoInput } from './github'
import { discoverJavaInstallations, ensureJavaRuntime, validateJavaExecutable } from './javaManager'
import { logger } from './log'
import { ensureMinecraftAndLoader } from './minecraftInstaller'
import { applyPackSync, planPackSync, readLocalManifest, readPackState } from './packUpdater'
import { pingMinecraftServer } from './serverPing'
import { ProfileStore, SettingsStore, totalSystemMemoryMb } from './storage'

const log = logger.scope('service')

export class LauncherService {
  readonly settingsStore: SettingsStore
  readonly profileStore: ProfileStore
  readonly catalogService: CatalogService

  private readonly activeOps = new Map<string, AbortController>()
  private readonly runningPacks = new Set<string>()
  private readonly progressListeners = new Set<(ev: ProgressEvent) => void>()
  private readonly stateListeners = new Set<(ev: PackStateEvent) => void>()
  private readonly gameListeners = new Set<(ev: GameEvent) => void>()

  constructor(
    private readonly userDataDir: string,
    private readonly requestOpts: CatalogRequestOptions = {}
  ) {
    this.settingsStore = new SettingsStore(userDataDir)
    this.profileStore = new ProfileStore(userDataDir)
    this.catalogService = new CatalogService(userDataDir)
  }

  onProgress(fn: (ev: ProgressEvent) => void): () => void {
    this.progressListeners.add(fn)
    return () => this.progressListeners.delete(fn)
  }

  onPackState(fn: (ev: PackStateEvent) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  onGameEvent(fn: (ev: GameEvent) => void): () => void {
    this.gameListeners.add(fn)
    return () => this.gameListeners.delete(fn)
  }

  private emitProgress(ev: ProgressEvent): void {
    for (const fn of this.progressListeners) {
      try {
        fn(ev)
      } catch {
        /* ignore */
      }
    }
  }

  private emitPackState(view: PackView): void {
    const ev: PackStateEvent = {
      packKey: view.key,
      status: view.status,
      installedVersion: view.installedVersion,
      lastError: view.lastError,
      conflicts: view.conflicts,
      warnings: view.warnings
    }
    for (const fn of this.stateListeners) {
      try {
        fn(ev)
      } catch {
        /* ignore */
      }
    }
  }

  private emitGameEvent(ev: GameEvent): void {
    for (const fn of this.gameListeners) {
      try {
        fn(ev)
      } catch {
        /* ignore */
      }
    }
  }

  getInstanceDir(installDir: string, packKey: string): string {
    return join(installDir, 'instances', packKey)
  }

  async getSettings(): Promise<Settings> {
    return this.settingsStore.load()
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.settingsStore.update(patch)
  }

  async getProfiles(): Promise<ProfilesState> {
    return this.profileStore.load()
  }

  async createProfile(name: string): Promise<ProfilesState> {
    return this.profileStore.createProfile(name)
  }

  async renameProfile(id: string, name: string): Promise<ProfilesState> {
    return this.profileStore.renameProfile(id, name)
  }

  async deleteProfile(id: string): Promise<ProfilesState> {
    return this.profileStore.deleteProfile(id)
  }

  async selectProfile(id: string): Promise<ProfilesState> {
    return this.profileStore.selectProfile(id)
  }

  async loadCatalog(): Promise<CatalogResult> {
    const settings = await this.settingsStore.load()
    const prevStates = new Map<string, PackView>()
    for (const e of this.catalogService.getAllEntries()) {
      prevStates.set(e.view.key, e.view)
    }

    const res = await this.catalogService.loadCatalog(settings, this.requestOpts)
    // Сохраняем текущие активные статусы (downloading/running/checking/conflict) поверх нового списка
    for (const pack of res.packs) {
      if (this.runningPacks.has(pack.key)) {
        pack.status = 'running'
      } else if (this.activeOps.has(pack.key)) {
        const prev = prevStates.get(pack.key)
        if (prev) pack.status = prev.status
      } else {
        const prev = prevStates.get(pack.key)
        if (prev && (prev.status === 'conflict' || prev.status === 'error')) {
          pack.status = prev.status
          pack.conflicts = prev.conflicts
          pack.lastError = prev.lastError
        }
        if (prev && prev.warnings.length > 0) {
          pack.warnings = prev.warnings
        }
      }
    }
    return res
  }

  async addCustomRepo(repoInput: string, branch?: string): Promise<CatalogResult> {
    const ref = parseRepoInput(repoInput, branch)
    const settings = await this.settingsStore.load()
    const existsAlready = settings.customRepos.some(
      (r) => r.repo.toLowerCase() === ref.repo.toLowerCase() && r.branch === ref.branch
    )
    if (!existsAlready) {
      await this.settingsStore.update({
        customRepos: [...settings.customRepos, ref]
      })
    }
    return this.loadCatalog()
  }

  async removeCustomRepo(repo: string): Promise<CatalogResult> {
    const settings = await this.settingsStore.load()
    await this.settingsStore.update({
      customRepos: settings.customRepos.filter((r) => r.repo.toLowerCase() !== repo.toLowerCase())
    })
    return this.loadCatalog()
  }

  cancelOperation(packKey: string): boolean {
    const ctrl = this.activeOps.get(packKey)
    if (!ctrl) return false
    ctrl.abort()
    return true
  }

  private acquireOp(packKey: string): AbortController {
    if (this.activeOps.has(packKey)) {
      throw new LauncherError(
        'busy',
        'Операция уже выполняется',
        'Дождитесь завершения текущей проверки или установки для этой сборки.'
      )
    }
    if (this.runningPacks.has(packKey)) {
      throw new LauncherError(
        'busy',
        'Игра уже запущена',
        'Закройте запущенную игру перед повторной проверкой или запуском.'
      )
    }
    const ctrl = new AbortController()
    this.activeOps.set(packKey, ctrl)
    return ctrl
  }

  private updateView(
    packKey: string,
    patch: Partial<Pick<PackView, 'status' | 'installedVersion' | 'lastError' | 'conflicts' | 'warnings' | 'version' | 'minecraft' | 'loader' | 'server'>>
  ): PackView | undefined {
    const entry = this.catalogService.getEntry(packKey)
    if (!entry) return undefined
    Object.assign(entry.view, patch)
    this.emitPackState(entry.view)
    return entry.view
  }

  async checkPack(packKey: string): Promise<PackView> {
    const entry = this.catalogService.getEntry(packKey)
    if (!entry) {
      throw new LauncherError('unknown', 'Сборка не найдена', 'Обновите каталог сборок и повторите.')
    }
    const ctrl = this.acquireOp(packKey)
    const settings = await this.settingsStore.load()
    const instanceDir = this.getInstanceDir(settings.installDir, packKey)

    try {
      this.updateView(packKey, { status: 'checking', lastError: null, conflicts: [] })
      this.emitProgress({
        packKey,
        operation: 'verify',
        stage: 'check',
        label: 'Проверка актуальности сборки на GitHub',
        bytesDone: 0,
        bytesTotal: 0,
        filesDone: 0,
        filesTotal: 0,
        speed: 0,
        cancellable: true
      })

      const fetched = await this.fetchPackOrOffline(
        packKey,
        entry.sourceRef,
        instanceDir,
        'check',
        ctrl.signal
      )
      const { pack, manifest, offline } = fetched
      entry.packInfo = pack

      const state = await readPackState(instanceDir)
      const installedVersion = state?.version ?? null

      if (!installedVersion) {
        return this.updateView(packKey, {
          version: pack.version,
          minecraft: pack.minecraft,
          loader: pack.loader,
          server: pack.server ?? null,
          installedVersion: null,
          status: 'not-installed',
          lastError: null,
          conflicts: [],
          warnings: []
        })!
      }

      if (!manifest) {
        return this.updateView(packKey, {
          version: pack.version,
          minecraft: pack.minecraft,
          loader: pack.loader,
          server: pack.server ?? null,
          installedVersion,
          status: 'ready',
          lastError: null,
          conflicts: [],
          warnings: ['Автономный режим: GitHub недоступен, проверка обновлений пропущена.']
        })!
      }

      const plan = await planPackSync(instanceDir, manifest, {
        fullVerify: settings.fullVerifyOnLaunch || installedVersion !== manifest.version,
        signal: ctrl.signal,
        onProgress: (p) =>
          this.emitProgress({
            packKey,
            operation: 'verify',
            ...p,
            cancellable: true
          })
      })

      if (offline) {
        const missingRequired = plan.toDownload.filter((f) => f.required)
        if (missingRequired.length > 0) {
          throw new LauncherError(
            'offline',
            'Не хватает обязательных файлов',
            `Отсутствуют файлы сборки (${missingRequired.length}), а GitHub сейчас недоступен.`,
            'Подключитесь к интернету, чтобы докачать недостающие файлы.'
          )
        }
      }

      let nextStatus: PackStatus = 'ready'
      if (plan.conflicts.length > 0) nextStatus = 'conflict'
      else if (
        !offline &&
        (plan.toDownload.length > 0 || plan.toDelete.length > 0 || installedVersion !== manifest.version)
      ) {
        nextStatus = 'update-available'
      }

      const warnings = offline
        ? ['Автономный режим: GitHub недоступен, проверка обновлений пропущена.', ...plan.warnings]
        : plan.warnings

      return this.updateView(packKey, {
        version: pack.version,
        minecraft: pack.minecraft,
        loader: pack.loader,
        server: pack.server ?? null,
        installedVersion,
        status: nextStatus,
        lastError: null,
        conflicts: plan.conflicts,
        warnings
      })!
    } catch (e) {
      const userErr = toUserError(e)
      const state = await readPackState(instanceDir)
      const fallbackStatus: PackStatus = isAbortError(e)
        ? state?.version
          ? 'ready'
          : 'not-installed'
        : 'error'
      this.updateView(packKey, {
        installedVersion: state?.version ?? entry.view.installedVersion,
        status: fallbackStatus,
        lastError: isAbortError(e) ? null : userErr
      })
      throw e
    } finally {
      this.activeOps.delete(packKey)
    }
  }

  async installPack(
    packKey: string,
    resolutions: Record<string, ConflictChoice> = {}
  ): Promise<PackView> {
    const entry = this.catalogService.getEntry(packKey)
    if (!entry) {
      throw new LauncherError('unknown', 'Сборка не найдена', 'Обновите каталог сборок и повторите.')
    }
    const ctrl = this.acquireOp(packKey)
    const settings = await this.settingsStore.load()
    const instanceDir = this.getInstanceDir(settings.installDir, packKey)

    try {
      await this.syncAndPrepare(packKey, entry.sourceRef, settings, instanceDir, resolutions, 'install', ctrl.signal)
      const state = await readPackState(instanceDir)
      return this.updateView(packKey, {
        installedVersion: state?.version ?? entry.packInfo.version,
        status: 'ready',
        lastError: null,
        conflicts: []
      })!
    } catch (e) {
      const userErr = toUserError(e)
      const state = await readPackState(instanceDir)
      if (e instanceof LauncherError && e.code === 'conflict') {
        this.updateView(packKey, {
          installedVersion: state?.version ?? null,
          status: 'conflict',
          lastError: userErr
        })
      } else if (isAbortError(e)) {
        this.updateView(packKey, {
          installedVersion: state?.version ?? null,
          status: state?.version ? 'update-available' : 'not-installed',
          lastError: null
        })
      } else {
        this.updateView(packKey, {
          installedVersion: state?.version ?? null,
          status: 'error',
          lastError: userErr
        })
      }
      throw e
    } finally {
      this.activeOps.delete(packKey)
    }
  }

  async playPack(
    packKey: string,
    opts: { resolutions?: Record<string, ConflictChoice>; joinServer?: boolean } = {}
  ): Promise<PackView> {
    const entry = this.catalogService.getEntry(packKey)
    if (!entry) {
      throw new LauncherError('unknown', 'Сборка не найдена', 'Обновите каталог сборок и повторите.')
    }
    const profile = await this.profileStore.getSelectedProfile()
    if (!profile) {
      throw new LauncherError(
        'no-profile',
        'Не выбран локальный профиль',
        'Создайте или выберите профиль на вкладке «Профили» перед запуском игры.'
      )
    }

    const ctrl = this.acquireOp(packKey)
    const settings = await this.settingsStore.load()
    const instanceDir = this.getInstanceDir(settings.installDir, packKey)

    try {
      const prepared = await this.syncAndPrepare(
        packKey,
        entry.sourceRef,
        settings,
        instanceDir,
        opts.resolutions ?? {},
        'play',
        ctrl.signal
      )

      this.updateView(packKey, {
        installedVersion: prepared.version,
        status: 'launching',
        lastError: null,
        conflicts: []
      })
      this.emitProgress({
        packKey,
        operation: 'play',
        stage: 'launch',
        label: 'Запуск Minecraft...',
        bytesDone: 1,
        bytesTotal: 1,
        filesDone: 1,
        filesTotal: 1,
        speed: 0,
        cancellable: false
      })

      const override = settings.packOverrides[packKey]
      const memoryMb = this.resolvePackMemoryMb(settings, entry.packInfo.recommendedMemoryMb, override?.memoryMb)
      const extraJvmArgs = override?.extraJvmArgs?.trim() ? override.extraJvmArgs : settings.extraJvmArgs
      const joinServer = opts.joinServer ?? settings.autoJoinServer

      this.runningPacks.add(packKey)
      try {
        await launchGame({
          packKey,
          installDir: settings.installDir,
          instanceDir,
          resolvedVersion: prepared.resolvedVersion,
          javaPath: prepared.javaInfo.path,
          profile,
          memoryMb,
          extraJvmArgs,
          resolution: settings.resolution,
          server: entry.packInfo.server ?? null,
          joinServer,
          onGameEvent: (ev) => {
            if (ev.state === 'started') {
              this.updateView(packKey, { status: 'running', lastError: null })
            } else if (ev.state === 'exited') {
              this.runningPacks.delete(packKey)
              const failed = ev.exitCode !== null && ev.exitCode !== undefined && ev.exitCode !== 0
              this.updateView(packKey, {
                status: failed ? 'error' : 'ready',
                lastError: failed
                  ? {
                      code: 'launch-failed',
                      title: 'Игра завершилась с ошибкой',
                      message: `Процесс Minecraft завершился с кодом ${ev.exitCode}.`,
                      hint: 'Проверьте логи запуска в разделе «Настройки и диагностика».'
                    }
                  : null
              })
            }
            this.emitGameEvent(ev)
          }
        })
      } catch (launchErr) {
        this.runningPacks.delete(packKey)
        throw launchErr
      }

      return entry.view
    } catch (e) {
      const userErr = toUserError(e)
      const state = await readPackState(instanceDir)
      if (e instanceof LauncherError && e.code === 'conflict') {
        this.updateView(packKey, {
          installedVersion: state?.version ?? null,
          status: 'conflict',
          lastError: userErr
        })
      } else if (isAbortError(e)) {
        this.updateView(packKey, {
          installedVersion: state?.version ?? null,
          status: state?.version ? 'ready' : 'not-installed',
          lastError: null
        })
      } else {
        this.updateView(packKey, {
          installedVersion: state?.version ?? null,
          status: 'error',
          lastError: userErr
        })
      }
      throw e
    } finally {
      this.activeOps.delete(packKey)
    }
  }

  private resolvePackMemoryMb(
    settings: Settings,
    recommendedMb: number,
    overrideMb?: number | null
  ): number {
    const maxSafe = Math.max(1024, totalSystemMemoryMb() - 1024)
    if (overrideMb && overrideMb >= 1024) {
      return Math.min(totalSystemMemoryMb(), overrideMb)
    }
    const base = Math.max(recommendedMb, settings.defaultMemoryMb ?? recommendedMb)
    return Math.min(maxSafe, base)
  }

  private async fetchPackOrOffline(
    packKey: string,
    sourceRef: NonNullable<ReturnType<CatalogService['getEntry']>>['sourceRef'],
    instanceDir: string,
    mode: 'install' | 'play' | 'check',
    signal: AbortSignal
  ): Promise<{ pack: PackInfo; manifest: Manifest | null; offline: boolean }> {
    const entry = this.catalogService.getEntry(packKey)
    try {
      const { pack, manifest } = await this.catalogService.fetchPackAndManifest(sourceRef, {
        ...this.requestOpts,
        signal
      })
      if (entry) entry.packInfo = pack
      await saveLocalPackMeta(instanceDir, {
        schemaVersion: 1,
        packKey,
        sourceRef,
        packInfo: pack,
        coverDataUrl: entry?.view.coverDataUrl ?? null
      }).catch(() => undefined)
      return { pack, manifest, offline: false }
    } catch (e) {
      const isNetworkErr =
        e instanceof LauncherError && (e.code === 'offline' || e.code === 'github-unavailable')
      if (!isNetworkErr || mode === 'install') throw e

      const state = await readPackState(instanceDir)
      if (!state?.version) throw e

      const localManifest = await readLocalManifest(
        instanceDir,
        this.requestOpts.isAllowed ?? isAllowedUrl
      )
      const fallbackPack: PackInfo | undefined = entry?.packInfo
      if (!fallbackPack) throw e

      log.warn(`GitHub недоступен, используем локальный запуск сборки ${packKey} (версия ${state.version})`)
      return { pack: fallbackPack, manifest: localManifest, offline: true }
    }
  }

  private async syncAndPrepare(
    packKey: string,
    sourceRef: NonNullable<ReturnType<CatalogService['getEntry']>>['sourceRef'],
    settings: Settings,
    instanceDir: string,
    resolutions: Record<string, ConflictChoice>,
    operation: 'install' | 'play',
    signal: AbortSignal
  ) {
    this.updateView(packKey, { status: 'checking', lastError: null })
    this.emitProgress({
      packKey,
      operation,
      stage: 'check',
      label: 'Проверка актуальности сборки на GitHub',
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      speed: 0,
      cancellable: true
    })

    // 1. Онлайн-проверка pack.json и manifest.json (или локальный офлайн-режим для уже установленной сборки)
    const { pack, manifest, offline } = await this.fetchPackOrOffline(
      packKey,
      sourceRef,
      instanceDir,
      operation,
      signal
    )

    await ensureDir(instanceDir)
    const state = await readPackState(instanceDir)

    let targetVersion = state?.version ?? pack.version
    let targetMc = pack.minecraft
    let targetLoader = pack.loader
    let targetJavaMajor: number | undefined

    if (manifest) {
      targetVersion = manifest.version
      targetMc = manifest.minecraft
      targetLoader = manifest.loader
      targetJavaMajor = manifest.java?.major

      const fullVerify =
        operation === 'install' || settings.fullVerifyOnLaunch || state?.version !== manifest.version

      // 2. Сверка фактических файлов сборки
      const plan = await planPackSync(instanceDir, manifest, {
        fullVerify,
        signal,
        onProgress: (p) =>
          this.emitProgress({
            packKey,
            operation,
            ...p,
            cancellable: true
          })
      })

      const warnings = offline
        ? ['Запуск в автономном режиме: GitHub недоступен, проверка обновлений пропущена.', ...plan.warnings]
        : plan.warnings

      this.updateView(packKey, {
        version: pack.version,
        minecraft: pack.minecraft,
        loader: pack.loader,
        server: pack.server ?? null,
        conflicts: plan.conflicts,
        warnings
      })

      if (offline) {
        const missingRequired = plan.toDownload.filter((f) => f.required)
        if (missingRequired.length > 0) {
          throw new LauncherError(
            'offline',
            'Не хватает файлов сборки для запуска без интернета',
            `Отсутствуют обязательные файлы (${missingRequired.length}), а GitHub сейчас недоступен.`,
            'Подключитесь к интернету, чтобы докачать недостающие файлы.'
          )
        }
      }

      // Проверяем нерешённые конфликты
      for (const conflict of plan.conflicts) {
        const choice = resolutions[conflict.path]
        if (!choice || (choice === 'keep' && !conflict.canKeep)) {
          throw new LauncherError(
            'conflict',
            'Обнаружены изменённые файлы сборки',
            `Необходимо выбрать действие для ${plan.conflicts.length} изменённых файлов перед продолжением.`,
            'Выберите замену с резервной копией или сохранение вашей версии (для необязательных файлов).'
          )
        }
        if (offline && choice === 'replace' && conflict.kind !== 'obsolete-modified') {
          throw new LauncherError(
            'offline',
            'Для восстановления файла нужен интернет',
            `Файл «${conflict.path}» изменён и требует загрузки эталонной версии с GitHub.`,
            'Подключитесь к интернету для восстановления файла.'
          )
        }
      }

      // 3. Применение обновлений (только при доступе к GitHub)
      if (
        !offline &&
        (plan.toDownload.length > 0 ||
          plan.toDelete.length > 0 ||
          plan.conflicts.length > 0 ||
          !state ||
          state.version !== manifest.version)
      ) {
        this.updateView(packKey, { status: 'downloading' })
        await applyPackSync(instanceDir, manifest, plan, resolutions, {
          ...this.requestOpts,
          signal,
          onProgress: (p) =>
            this.emitProgress({
              packKey,
              operation,
              ...p,
              cancellable: true
            })
        })
      }
    } else {
      this.updateView(packKey, {
        warnings: ['Запуск в автономном режиме: GitHub недоступен, проверка обновлений пропущена.']
      })
    }

    // 4. Java + Minecraft + Loader
    this.updateView(packKey, { status: 'downloading', conflicts: [] })
    const customJavaPath = settings.packOverrides[packKey]?.javaPath ?? settings.javaPath
    const { resolvedVersion, javaInfo } = await ensureMinecraftAndLoader({
      installDir: settings.installDir,
      instanceDir,
      minecraftVersion: targetMc,
      loader: targetLoader,
      manifestJavaMajor: targetJavaMajor,
      signal,
      resolveJava: (major) =>
        ensureJavaRuntime(major, settings.installDir, {
          customJavaPath,
          signal,
          onProgress: (p) =>
            this.emitProgress({
              packKey,
              operation,
              ...p,
              cancellable: true
            })
        }),
      onProgress: (p) =>
        this.emitProgress({
          packKey,
          operation,
          ...p,
          cancellable: true
        })
    })

    log.info(`Сборка ${packKey} готова (MC ${targetMc}, версия ${targetVersion}, Java ${javaInfo.version}${offline ? ', офлайн' : ''})`)
    return { version: targetVersion, resolvedVersion, javaInfo }
  }

  async listJava(): Promise<JavaInfoView[]> {
    const settings = await this.settingsStore.load()
    return discoverJavaInstallations(settings.installDir)
  }

  async testJava(javaPath: string): Promise<JavaInfoView> {
    return validateJavaExecutable(javaPath)
  }

  async pingServer(host: string, port?: number): Promise<ServerStatus> {
    return pingMinecraftServer(host, port)
  }

  async loadNews(): Promise<NewsResult> {
    return this.catalogService.loadNews(this.catalogService.getAllEntries(), this.requestOpts)
  }

  async getLatestCrashReport(packKey: string): Promise<CrashReportView | null> {
    const settings = await this.settingsStore.load()
    const crashDir = join(this.getInstanceDir(settings.installDir, packKey), 'crash-reports')
    let names: string[]
    try {
      names = await readdir(crashDir)
    } catch {
      return null
    }
    const candidates: Array<{ name: string; fullPath: string; mtimeMs: number }> = []
    for (const name of names) {
      if (!/\.(txt|log)$/i.test(name)) continue
      const fullPath = join(crashDir, name)
      const info = await stat(fullPath).catch(() => null)
      if (info?.isFile()) {
        candidates.push({ name, fullPath, mtimeMs: info.mtimeMs })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const latest = candidates[0]
    const raw = await readFile(latest.fullPath, 'utf8').catch(() => '')
    return {
      fileName: latest.name,
      modifiedAt: new Date(latest.mtimeMs).toISOString(),
      content: raw.slice(0, 24_000)
    }
  }

  async exportDiagnostics(versions: { launcher: string; electron: string; node: string }): Promise<string> {
    const settings = await this.settingsStore.load()
    const profiles = await this.profileStore.load()
    const javaList = await this.listJava().catch(() => [])
    const packs = this.catalogService.getAllEntries().map((e) => e.view)
    return buildDiagnosticsReport({
      launcherVersion: versions.launcher,
      electronVersion: versions.electron,
      nodeVersion: versions.node,
      settings,
      profilesCount: profiles.profiles.length,
      packs,
      javaList
    })
  }
}
