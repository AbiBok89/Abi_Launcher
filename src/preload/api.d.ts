import type {
  AppInfo,
  CatalogResult,
  ConflictChoice,
  CrashReportView,
  GameEvent,
  JavaInfoView,
  LauncherUpdateState,
  LogEntry,
  NewsResult,
  PackStateEvent,
  PackSubfolder,
  PackView,
  ProfilesState,
  ProgressEvent,
  Result,
  ServerStatus,
  Settings
} from '@shared/types'

export type SystemTheme = 'light' | 'dark'

export interface AbiApi {
  getAppInfo(): Promise<Result<AppInfo>>
  getSettings(): Promise<Result<Settings>>
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>
  pickDirectory(defaultPath?: string): Promise<Result<string | null>>
  pickJavaExecutable(): Promise<Result<string | null>>

  getSystemTheme(): Promise<Result<SystemTheme>>
  onSystemThemeChanged(cb: (theme: SystemTheme) => void): () => void

  windowMinimize(): Promise<Result<void>>
  windowToggleMaximize(): Promise<Result<boolean>>
  windowClose(): Promise<Result<void>>
  windowIsMaximized(): Promise<Result<boolean>>
  onWindowMaximizedChanged(cb: (maximized: boolean) => void): () => void

  getProfiles(): Promise<Result<ProfilesState>>
  createProfile(name: string): Promise<Result<ProfilesState>>
  renameProfile(id: string, name: string): Promise<Result<ProfilesState>>
  deleteProfile(id: string): Promise<Result<ProfilesState>>
  selectProfile(id: string): Promise<Result<ProfilesState>>

  loadCatalog(): Promise<Result<CatalogResult>>
  addCustomRepo(repoInput: string, branch?: string): Promise<Result<CatalogResult>>
  removeCustomRepo(repo: string): Promise<Result<CatalogResult>>

  checkPack(packKey: string): Promise<Result<PackView>>
  installPack(packKey: string, resolutions?: Record<string, ConflictChoice>): Promise<Result<PackView>>
  playPack(
    packKey: string,
    options?: { resolutions?: Record<string, ConflictChoice>; joinServer?: boolean }
  ): Promise<Result<PackView>>
  cancelOperation(packKey: string): Promise<Result<boolean>>

  openInstanceFolder(packKey: string, subfolder?: PackSubfolder): Promise<Result<boolean>>
  getLatestCrashReport(packKey: string): Promise<Result<CrashReportView | null>>
  listJava(): Promise<Result<JavaInfoView[]>>
  testJava(javaPath: string): Promise<Result<JavaInfoView>>

  pingServer(host: string, port?: number): Promise<Result<ServerStatus>>
  loadNews(): Promise<Result<NewsResult>>

  getLogs(): Promise<Result<LogEntry[]>>
  onLog(cb: (entry: LogEntry) => void): () => void
  exportDiagnostics(): Promise<Result<string | null>>

  getLauncherUpdateState(): Promise<Result<LauncherUpdateState>>
  checkLauncherUpdate(): Promise<Result<LauncherUpdateState>>
  downloadLauncherUpdate(): Promise<Result<LauncherUpdateState>>
  cancelLauncherUpdateDownload(): Promise<Result<boolean>>
  installLauncherUpdate(): Promise<Result<void>>
  openLauncherReleasePage(): Promise<Result<boolean>>
  onLauncherUpdateState(cb: (state: LauncherUpdateState) => void): () => void

  onProgress(cb: (ev: ProgressEvent) => void): () => void
  onPackState(cb: (ev: PackStateEvent) => void): () => void
  onGameEvent(cb: (ev: GameEvent) => void): () => void
}

declare global {
  interface Window {
    abi: AbiApi
  }
}
