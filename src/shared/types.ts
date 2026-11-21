import type { Loader, ServerRef } from './schemas'

/** Типы, которыми обмениваются main и renderer через IPC. */

export type ThemeSetting = 'system' | 'light' | 'dark'
export type AfterLaunch = 'keep' | 'minimize' | 'hide' | 'close'

export interface Settings {
  theme: ThemeSetting
  /** Корневая папка игровых данных (общие файлы Minecraft, Java, сборки). */
  installDir: string
  /** Ссылка на официальный каталог (raw.githubusercontent.com). Пусто — каталог не загружается. */
  catalogUrl: string
  /** Дополнительные репозитории сборок, добавленные вручную. */
  customRepos: CustomRepo[]
  /** Память по умолчанию, МБ (если у сборки не задано своё значение). */
  defaultMemoryMb: number | null
  /** Путь к Java по умолчанию; null — автоматический выбор. */
  javaPath: string | null
  resolution: { width: number; height: number; fullscreen: boolean }
  afterLaunch: AfterLaunch
  /** Полная проверка SHA-256 всех файлов перед каждым запуском (медленнее). */
  fullVerifyOnLaunch: boolean
  /** Подключаться к серверу сборки при запуске, если версия игры это поддерживает. */
  autoJoinServer: boolean
  /** Глобальные дополнительные аргументы JVM (через пробел). */
  extraJvmArgs: string
  /** Автоматически проверять обновления лаунчера через GitHub Releases при запуске. */
  autoCheckLauncherUpdates: boolean
  /** Разрешить свободное изменение размера окна лаунчера. */
  resizableWindow: boolean
  packOverrides: Record<string, PackOverride>
}

export interface PackOverride {
  memoryMb?: number | null
  javaPath?: string | null
  extraJvmArgs?: string | null
}

export interface CustomRepo {
  repo: string
  branch: string
  path: string
}

export interface Profile {
  id: string
  name: string
  uuid: string
  createdAt: string
}

export interface ProfilesState {
  profiles: Profile[]
  selectedId: string | null
}

export type PackStatus =
  | 'not-installed'
  | 'checking'
  | 'downloading'
  | 'update-available'
  | 'ready'
  | 'conflict'
  | 'error'
  | 'launching'
  | 'running'

export interface PackView {
  key: string
  id: string
  source: { repo: string; branch: string; official: boolean }
  name: string
  summary: string
  description: string
  coverDataUrl: string | null
  version: string
  minecraft: string
  loader: Loader
  recommendedMemoryMb: number
  minMemoryMb: number | null
  server: ServerRef | null
  installedVersion: string | null
  status: PackStatus
  lastError: UserError | null
  conflicts: ConflictView[]
  warnings: string[]
}

export interface PackLoadError {
  repo: string
  message: string
}

export interface CatalogResult {
  packs: PackView[]
  errors: PackLoadError[]
  /** true — GitHub недоступен, показаны сохранённые данные. */
  fromCache: boolean
  catalogError: string | null
  loadedAt: string
}

export type ConflictKind = 'modified' | 'untracked' | 'obsolete-modified'
export type ConflictChoice = 'replace' | 'keep'

export interface ConflictView {
  path: string
  kind: ConflictKind
  /** Можно ли оставить версию игрока (необязательный файл). */
  canKeep: boolean
}

export interface UserError {
  code: ErrorCode
  title: string
  message: string
  hint?: string
}

export type ErrorCode =
  | 'offline'
  | 'github-unavailable'
  | 'manifest-invalid'
  | 'pack-mismatch'
  | 'download-failed'
  | 'integrity'
  | 'disk-space'
  | 'java'
  | 'minecraft-install'
  | 'conflict'
  | 'cancelled'
  | 'busy'
  | 'no-profile'
  | 'launch-failed'
  | 'filesystem'
  | 'unknown'

export type Stage =
  | 'check'
  | 'verify'
  | 'download'
  | 'extract'
  | 'apply'
  | 'java'
  | 'minecraft'
  | 'loader'
  | 'launch'

export interface ProgressEvent {
  packKey: string
  operation: 'install' | 'play' | 'verify'
  stage: Stage
  label: string
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  /** Байт/с, скользящее среднее. */
  speed: number
  cancellable: boolean
}

export interface LogEntry {
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export interface JavaInfoView {
  path: string
  version: string
  majorVersion: number
  managed: boolean
}

export interface ServerStatus {
  online: boolean
  playersOnline: number | null
  playersMax: number | null
  version: string | null
  motd: string | null
  latencyMs: number | null
  error: string | null
}

export interface NewsItemView {
  id: string
  date: string
  title: string
  body: string
  packVersion: string | null
  packKey: string
  packName: string
}

export interface NewsResult {
  items: NewsItemView[]
  errors: PackLoadError[]
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
  arch: string
  totalMemoryMb: number
  userDataDir: string
  defaultInstallDir: string
}

export type PackSubfolder =
  | 'root'
  | 'mods'
  | 'saves'
  | 'shaderpacks'
  | 'resourcepacks'
  | 'screenshots'
  | 'crash-reports'
  | 'logs'
  | 'backups'

export type PackAddonCategory = 'mod' | 'shader' | 'resourcepack'
export type PackAddonSource = 'pack' | 'user'

export interface PackAddonItem {
  fileName: string
  name: string
  category: PackAddonCategory
  source: PackAddonSource
  enabled: boolean
  sizeBytes: number
}

export interface PackBackupItem {
  name: string
  modifiedAt: string
  filesCount: number
}

export interface PackContentView {
  addons: PackAddonItem[]
  backups: PackBackupItem[]
  instanceExists: boolean
}

export interface CrashReportView {
  fileName: string
  modifiedAt: string
  content: string
}

export interface GameEvent {
  packKey: string
  state: 'started' | 'exited'
  exitCode?: number | null
  crashReport?: string | null
  crashReportPath?: string | null
}

export type LauncherUpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface LauncherReleaseAssetInfo {
  name: string
  url: string
  size: number
  sha256: string | null
}

export interface LauncherUpdateState {
  phase: LauncherUpdatePhase
  currentVersion: string
  latestVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseUrl: string | null
  publishedAt: string | null
  asset: LauncherReleaseAssetInfo | null
  downloadedPath: string | null
  progressBytesDone: number
  progressBytesTotal: number
  progressSpeed: number
  error: string | null
  canAutoInstall: boolean
  installMode: 'portable' | 'installer' | 'manual'
  checkedAt: string | null
}

export interface PackStateEvent {
  packKey: string
  status: PackStatus
  installedVersion: string | null
  lastError: UserError | null
  conflicts: ConflictView[]
  warnings: string[]
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: UserError }
