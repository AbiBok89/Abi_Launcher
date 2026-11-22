import { useEffect, useState } from 'react'
import {
  Check,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileArchive,
  FolderOpen,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Sun,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import type {
  AfterLaunch,
  AppInfo,
  JavaInfoView,
  LauncherUpdateState,
  PackView,
  ServerStatus,
  Settings,
  ThemeSetting
} from '@shared/types'
import type { SystemTheme } from '../../../preload/api'
import {
  formatBytes,
  formatMemoryGb,
  formatServerAddress,
  formatSpeed
} from '../utils/format'
import { MemoryAllocationBar } from './MemoryAllocationBar'

function serverKey(host: string, port?: number): string {
  return `${host}:${port ?? 25565}`
}

function isAllowed20tpsHost(host?: string | null): boolean {
  if (!host) return false
  const clean = host.trim().replace(/\.+$/, '').toLowerCase()
  return clean.endsWith('.20tps.ru') && clean.length > '.20tps.ru'.length
}

const JVM_PRESETS: Array<{ label: string; args: string; title: string }> = [
  {
    label: '+ UTF-8',
    args: '-Dfile.encoding=UTF-8',
    title: 'Принудительная кодировка UTF-8 для консоли и модов'
  },
  {
    label: '+ ZGC (Java 21+)',
    args: '-XX:+UseZGC -XX:+ZGenerational',
    title: 'Поколенческий ZGC (для Minecraft 1.20.5+ на Java 21)'
  },
  {
    label: '+ Таймаут Forge',
    args: '-Dfml.readTimeout=120',
    title: 'Увеличивает таймаут сетевого чтения Forge/FML при входе на тяжёлые серверы'
  }
]

function appendJvmPreset(current: string, presetArgs: string): string {
  const existing = current.trim().split(/\s+/).filter(Boolean)
  const add = presetArgs.split(/\s+/).filter(Boolean)
  for (const token of add) {
    if (!existing.includes(token)) existing.push(token)
  }
  return existing.join(' ')
}

interface AllServersViewProps {
  packs: PackView[]
  serverStatuses: Record<string, ServerStatus>
  pingingServers: Record<string, boolean>
  onPingServer: (host: string, port?: number) => void
  onJoinPack: (packKey: string) => void
  onToast: (message: string, tone?: 'info' | 'ok' | 'warn') => void
}

export function AllServersView({
  packs,
  serverStatuses,
  pingingServers,
  onPingServer,
  onJoinPack,
  onToast
}: AllServersViewProps) {
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
  const packsWithServers = packs.filter((p) => p.server && isAllowed20tpsHost(p.server.host))

  const handleCopy = (addr: string) => {
    navigator.clipboard?.writeText(addr).catch(() => undefined)
    setCopiedAddr(addr)
    onToast(`Адрес ${addr} скопирован`, 'info')
    window.setTimeout(() => setCopiedAddr((cur) => (cur === addr ? null : cur)), 1600)
  }

  const handlePingAll = () => {
    for (const p of packsWithServers) {
      if (p.server) onPingServer(p.server.host, p.server.port)
    }
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            Серверы каталога
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            Сводный мониторинг всех серверов, привязанных к вашим сборкам. Статус сервера конкретной
            сборки также доступен прямо на её странице обзора.
          </p>
        </div>
        <button
          type="button"
          onClick={handlePingAll}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Обновить все</span>
        </button>
      </div>

      {packsWithServers.length === 0 ? (
        <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-sm text-slate-500">
          В подключённых сборках пока не указано ни одного сервера.
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#0e1521] overflow-hidden">
          {packsWithServers.map((pack) => {
            const srv = pack.server!
            const sKey = serverKey(srv.host, srv.port)
            const st = serverStatuses[sKey]
            const isPinging = Boolean(pingingServers[sKey])
            const addr = formatServerAddress(srv.host, srv.port)

            return (
              <div
                key={pack.key}
                className="p-5 flex flex-wrap items-center justify-between gap-4 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <Server className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {srv.name}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      · {pack.name} {pack.version}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400 font-mono-tabular">
                    <span>{addr}</span>
                    <span aria-hidden="true">·</span>
                    {st ? (
                      st.online ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-sans font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          Онлайн · {st.playersOnline ?? '?'}/{st.playersMax ?? '?'} игроков
                          {st.latencyMs !== null ? ` · ${st.latencyMs} мс` : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400 font-sans font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                          Офлайн{st.error ? ` (${st.error})` : ''}
                        </span>
                      )
                    ) : (
                      <span className="text-slate-500 font-sans">Не проверен</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleCopy(addr)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    {copiedAddr === addr ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedAddr === addr ? 'Скопировано' : 'Копировать IP'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isPinging}
                    onClick={() => onPingServer(srv.host, srv.port)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isPinging ? 'animate-spin' : ''}`} />
                    <span>Пинг</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onJoinPack(pack.key)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Запустить и зайти</span>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface GlobalSettingsViewProps {
  appInfo: AppInfo | null
  settings: Settings
  systemTheme: SystemTheme
  packs: PackView[]
  javaList: JavaInfoView[]
  updateState: LauncherUpdateState | null
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void>
  onPickDirectory: () => Promise<void>
  onPickJava: () => Promise<string | null>
  onRefreshJava: () => Promise<void>
  onTestJava: (javaPath: string) => Promise<JavaInfoView>
  onOpenAddRepo: () => void
  onRemoveRepo: (repo: string) => Promise<void>
  onExportDiagnostics: () => Promise<string | null>
  onCheckUpdate: () => Promise<void>
  onDownloadUpdate: () => Promise<void>
  onCancelUpdateDownload: () => Promise<void>
  onInstallUpdate: () => Promise<void>
  onOpenReleasePage: () => Promise<void>
  onOpenConsole: () => void
  onToast: (message: string, tone?: 'info' | 'ok' | 'warn') => void
}

export function GlobalSettingsView({
  appInfo,
  settings,
  systemTheme,
  packs,
  javaList,
  updateState,
  onUpdateSettings,
  onPickDirectory,
  onPickJava,
  onRefreshJava,
  onTestJava,
  onOpenAddRepo,
  onRemoveRepo,
  onExportDiagnostics,
  onCheckUpdate,
  onDownloadUpdate,
  onCancelUpdateDownload,
  onInstallUpdate,
  onOpenReleasePage,
  onOpenConsole,
  onToast
}: GlobalSettingsViewProps) {
  const systemMemMb = appInfo?.totalMemoryMb ?? 16384
  const sliderMax = Math.max(4096, Math.min(32768, Math.floor(systemMemMb / 512) * 512))
  const activeDefaultMem = settings.defaultMemoryMb ?? Math.min(8192, Math.max(4096, Math.floor((systemMemMb * 0.5) / 512) * 512))

  const [memoryInput, setMemoryInput] = useState(activeDefaultMem)
  const [widthInput, setWidthInput] = useState(settings.resolution.width)
  const [heightInput, setHeightInput] = useState(settings.resolution.height)
  const [jvmArgsInput, setJvmArgsInput] = useState(settings.extraJvmArgs)
  const [javaInput, setJavaInput] = useState(settings.javaPath ?? '')
  const [catalogUrlInput, setCatalogUrlInput] = useState(settings.catalogUrl)

  useEffect(() => {
    setMemoryInput(activeDefaultMem)
  }, [activeDefaultMem])

  useEffect(() => {
    setWidthInput(settings.resolution.width)
    setHeightInput(settings.resolution.height)
  }, [settings.resolution.width, settings.resolution.height])

  useEffect(() => {
    setJvmArgsInput(settings.extraJvmArgs)
  }, [settings.extraJvmArgs])

  useEffect(() => {
    setJavaInput(settings.javaPath ?? '')
  }, [settings.javaPath])

  useEffect(() => {
    setCatalogUrlInput(settings.catalogUrl)
  }, [settings.catalogUrl])

  const runAction = async (fn: () => Promise<void>, okText?: string) => {
    try {
      await fn()
      if (okText) onToast(okText, 'ok')
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), 'warn')
    }
  }

  const updatePct =
    updateState && updateState.progressBytesTotal > 0
      ? Math.min(100, Math.round((updateState.progressBytesDone / updateState.progressBytesTotal) * 100))
      : 0

  return (
    <div className="p-6 max-w-4xl space-y-8">
      <div className="border-b border-slate-200 dark:border-slate-800 pb-4">
        <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
          Глобальные настройки лаунчера
        </h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
          Общие параметры по умолчанию для всех сборок. Индивидуальные значения ОЗУ, Java и
          JVM-аргументов можно переопределить во вкладке «Параметры» внутри любой сборки.
        </p>
      </div>

      {/* Launcher self-updater */}
      <section className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] space-y-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Обновление AbiLauncher (GitHub Releases)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono-tabular mt-0.5">
              v{updateState?.currentVersion ?? appInfo?.version ?? '0.3.5'} ·{' '}
              {updateState?.installMode === 'portable'
                ? 'Portable (.exe)'
                : updateState?.installMode === 'installer'
                  ? 'Установленный (NSIS)'
                  : 'Ручной / Dev'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={
                updateState?.phase === 'checking' ||
                updateState?.phase === 'downloading' ||
                updateState?.phase === 'installing'
              }
              onClick={() => void runAction(() => onCheckUpdate())}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  updateState?.phase === 'checking' || updateState?.phase === 'installing'
                    ? 'animate-spin'
                    : ''
                }`}
              />
              <span>
                {updateState?.phase === 'checking'
                  ? 'Проверка…'
                  : updateState?.phase === 'installing'
                    ? 'Установка…'
                    : 'Проверить и обновить'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void runAction(() => onOpenReleasePage())}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>GitHub Releases</span>
            </button>
          </div>
        </div>

        {updateState?.phase === 'up-to-date' && (
          <div className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
            {updateState.latestVersion
              ? `Установлена актуальная версия лаунчера (v${updateState.latestVersion}).`
              : 'Новых релизов пока нет.'}
          </div>
        )}

        {(updateState?.phase === 'available' || updateState?.phase === 'downloaded') && (
          <div className="p-3.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-bold text-slate-900 dark:text-slate-100">
                Доступна версия v{updateState.latestVersion}
                {updateState.releaseName ? ` · ${updateState.releaseName}` : ''}
              </span>
              {updateState.asset && (
                <span className="font-mono-tabular text-slate-500 dark:text-slate-400">
                  {updateState.asset.name} · {formatBytes(updateState.asset.size)}
                </span>
              )}
            </div>
            {updateState.releaseNotes && (
              <div className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-line max-h-32 overflow-y-auto">
                {updateState.releaseNotes}
              </div>
            )}
            <div className="flex items-center gap-2">
              {updateState.phase === 'available' && updateState.asset && (
                <button
                  type="button"
                  onClick={() => void runAction(() => onDownloadUpdate())}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>
                    {updateState.canAutoInstall
                      ? `Обновить до v${updateState.latestVersion}`
                      : `Скачать v${updateState.latestVersion}`}
                  </span>
                </button>
              )}
              {updateState.phase === 'downloaded' && updateState.canAutoInstall && (
                <button
                  type="button"
                  onClick={() => void runAction(() => onInstallUpdate())}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Установить и перезапустить</span>
                </button>
              )}
              {updateState.phase === 'downloaded' && !updateState.canAutoInstall && (
                <span className="text-xs font-mono-tabular text-slate-500">
                  Скачано: {updateState.downloadedPath}
                </span>
              )}
            </div>
          </div>
        )}

        {updateState?.phase === 'installing' && (
          <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            Устанавливается обновление v{updateState.latestVersion} — лаунчер сейчас перезапустится…
          </div>
        )}

        {updateState?.phase === 'downloading' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-mono-tabular">
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                Загрузка v{updateState.latestVersion}: {updatePct}% ·{' '}
                {formatBytes(updateState.progressBytesDone)} /{' '}
                {formatBytes(updateState.progressBytesTotal)} ·{' '}
                {formatSpeed(updateState.progressSpeed)}
              </span>
              <button
                type="button"
                onClick={() => void onCancelUpdateDownload()}
                className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:underline font-sans"
              >
                <X className="w-3.5 h-3.5" />
                <span>Отменить</span>
              </button>
            </div>
            <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-[width] duration-200"
                style={{ width: `${updatePct}%` }}
              />
            </div>
          </div>
        )}

        {updateState?.phase === 'error' && updateState.error && (
          <div className="text-xs text-rose-600 dark:text-rose-400">{updateState.error}</div>
        )}

        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.autoCheckLauncherUpdates}
            onChange={(e) =>
              void runAction(() =>
                onUpdateSettings({ autoCheckLauncherUpdates: e.target.checked })
              )
            }
            className="accent-emerald-600 dark:accent-emerald-500"
          />
          <span>Автоматически проверять и устанавливать обновления AbiLauncher при запуске</span>
        </label>
      </section>

      {/* Theme & Behavior */}
      <section className="space-y-4">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Внешний вид и поведение
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Тема оформления (системная: {systemTheme === 'dark' ? 'тёмная' : 'светлая'})
            </div>
            <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-200/75 dark:bg-slate-800/80">
              {(
                [
                  ['dark', 'Тёмная', Moon],
                  ['light', 'Светлая', Sun],
                  ['system', 'Системная', Monitor]
                ] as Array<[ThemeSetting, string, typeof Moon]>
              ).map(([mode, label, Icon]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => void runAction(() => onUpdateSettings({ theme: mode }))}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    settings.theme === mode
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              После запуска Minecraft
            </label>
            <select
              value={settings.afterLaunch}
              onChange={(e) =>
                void runAction(() =>
                  onUpdateSettings({ afterLaunch: e.target.value as AfterLaunch })
                )
              }
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            >
              <option value="keep">Оставлять окно лаунчера открытым</option>
              <option value="minimize">Сворачивать в панель задач</option>
              <option value="hide">Скрывать до выхода из игры</option>
              <option value="close">Закрывать лаунчер</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pt-1">
          <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.resizableWindow}
              onChange={(e) =>
                void runAction(
                  () => onUpdateSettings({ resizableWindow: e.target.checked }),
                  e.target.checked
                    ? 'Изменение размера окна лаунчера включено'
                    : 'Размер окна зафиксирован (1240×800)'
                )
              }
              className="accent-emerald-600 dark:accent-emerald-500"
            />
            <span>Разрешить изменение размера окна лаунчера</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoJoinServer}
              onChange={(e) =>
                void runAction(() => onUpdateSettings({ autoJoinServer: e.target.checked }))
              }
              className="accent-emerald-600 dark:accent-emerald-500"
            />
            <span>Автоподключение к серверу сборки при запуске</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.fullVerifyOnLaunch}
              onChange={(e) =>
                void runAction(() => onUpdateSettings({ fullVerifyOnLaunch: e.target.checked }))
              }
              className="accent-emerald-600 dark:accent-emerald-500"
            />
            <span>
              Проверять SHA-256 всех файлов перед каждым запуском (по умолчанию скачивание идёт
              только при выходе новой версии)
            </span>
          </label>
        </div>
      </section>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* Memory, Resolution & Install Dir */}
      <section className="space-y-5">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Память, разрешение окна и папка данных
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] space-y-2.5">
            <div className="flex items-baseline justify-between">
              <label className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Выделяемая ОЗУ по умолчанию
              </label>
              <span className="font-mono-tabular text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                {memoryInput} МБ ({formatMemoryGb(memoryInput)})
              </span>
            </div>
            <input
              type="range"
              min={2048}
              max={sliderMax}
              step={512}
              value={Math.min(memoryInput, sliderMax)}
              onChange={(e) => setMemoryInput(Number(e.target.value))}
              onMouseUp={() =>
                void runAction(
                  () => onUpdateSettings({ defaultMemoryMb: memoryInput }),
                  `ОЗУ по умолчанию: ${formatMemoryGb(memoryInput)}`
                )
              }
              onKeyUp={() =>
                void runAction(() => onUpdateSettings({ defaultMemoryMb: memoryInput }))
              }
              className="w-full accent-emerald-600 dark:accent-emerald-500"
            />
            <MemoryAllocationBar
              compact
              activeMemoryMb={memoryInput}
              systemMemoryMb={systemMemMb}
            />
          </div>

          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] space-y-3">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Разрешение окна игры
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={640}
                max={7680}
                value={widthInput}
                onChange={(e) => setWidthInput(Number(e.target.value))}
                className="w-24 px-2.5 py-1.5 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <span className="text-xs text-slate-400">×</span>
              <input
                type="number"
                min={480}
                max={4320}
                value={heightInput}
                onChange={(e) => setHeightInput(Number(e.target.value))}
                className="w-24 px-2.5 py-1.5 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() =>
                  void runAction(
                    () =>
                      onUpdateSettings({
                        resolution: {
                          ...settings.resolution,
                          width: widthInput,
                          height: heightInput
                        }
                      }),
                    'Разрешение окна сохранено'
                  )
                }
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors"
              >
                Применить
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                [1280, 720],
                [1600, 900],
                [1920, 1080]
              ].map(([w, h]) => (
                <button
                  key={`${w}x${h}`}
                  type="button"
                  onClick={() => {
                    setWidthInput(w)
                    setHeightInput(h)
                    void runAction(() =>
                      onUpdateSettings({
                        resolution: { ...settings.resolution, width: w, height: h }
                      })
                    )
                  }}
                  className="px-2 py-1 text-[11px] font-mono-tabular rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  {w}×{h}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.resolution.fullscreen}
                onChange={(e) =>
                  void runAction(() =>
                    onUpdateSettings({
                      resolution: { ...settings.resolution, fullscreen: e.target.checked }
                    })
                  )
                }
                className="accent-emerald-600 dark:accent-emerald-500"
              />
              <span>Запускать в полноэкранном режиме</span>
            </label>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Папка для сборок, Minecraft и Java
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={settings.installDir}
              className="flex-1 px-3 py-2 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => void runAction(() => onPickDirectory())}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Выбрать…</span>
            </button>
            {appInfo && settings.installDir !== appInfo.defaultInstallDir && (
              <button
                type="button"
                onClick={() =>
                  void runAction(
                    () => onUpdateSettings({ installDir: appInfo.defaultInstallDir }),
                    'Папка сброшена по умолчанию'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Сброс</span>
              </button>
            )}
          </div>
        </div>

        {/* Global JVM Args */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Дополнительные JVM-аргументы по умолчанию
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={jvmArgsInput}
              onChange={(e) => setJvmArgsInput(e.target.value)}
              placeholder="-Dfile.encoding=UTF-8 -Dfml.readTimeout=120"
              className="flex-1 px-3 py-2 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={() =>
                void runAction(
                  () => onUpdateSettings({ extraJvmArgs: jvmArgsInput.trim() }),
                  'JVM-аргументы сохранены'
                )
              }
              className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap shrink-0"
            >
              Сохранить
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {JVM_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                title={preset.title}
                onClick={() => setJvmArgsInput((cur) => appendJvmPreset(cur, preset.args))}
                className="px-2.5 py-1 text-[11px] font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* Java Runtime */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>Java Runtime</span>
          </h3>
          <button
            type="button"
            onClick={() => void runAction(() => onRefreshJava(), 'Список Java обновлён')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Найти Java</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={javaInput}
            onChange={(e) => setJavaInput(e.target.value)}
            placeholder="Автоматически (лаунчер сам подготовит совместимую Java)"
            className="flex-1 px-3 py-2 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={async () => {
              const picked = await onPickJava()
              if (picked) setJavaInput(picked)
            }}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Обзор…
          </button>
          <button
            type="button"
            onClick={() =>
              void runAction(async () => {
                if (!javaInput.trim()) {
                  await onUpdateSettings({ javaPath: null })
                  onToast('Включён автоматический выбор Java', 'ok')
                  return
                }
                const info = await onTestJava(javaInput.trim())
                await onUpdateSettings({ javaPath: info.path })
                onToast(`Выбрана Java ${info.majorVersion} (${info.version})`, 'ok')
              })
            }
            className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] whitespace-nowrap shrink-0"
          >
            Проверить
          </button>
        </div>

        {javaList.length > 0 && (
          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#0e1521]">
            {javaList.map((j) => {
              const isSelected = settings.javaPath === j.path
              return (
                <div
                  key={j.path}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      Java {j.majorVersion}{' '}
                      <span className="font-normal text-slate-500">
                        ({j.version} · {j.managed ? 'AbiLauncher' : 'Системная'})
                      </span>
                    </div>
                    <div className="font-mono-tabular text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {j.path}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void runAction(
                        () => onUpdateSettings({ javaPath: j.path }),
                        `Выбрана Java ${j.majorVersion}`
                      )
                    }
                    className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                        : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {isSelected ? 'Выбрана' : 'Выбрать'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* Catalog & Custom Repos */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Источники сборок GitHub
          </h3>
          <button
            type="button"
            onClick={onOpenAddRepo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Добавить GitHub</span>
          </button>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
            Адрес официального каталога (catalog.json)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={catalogUrlInput}
              onChange={(e) => setCatalogUrlInput(e.target.value)}
              className="flex-1 px-3 py-2 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() =>
                void runAction(
                  () => onUpdateSettings({ catalogUrl: catalogUrlInput }),
                  'Адрес каталога обновлён'
                )
              }
              className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117]"
            >
              Сохранить
            </button>
          </div>
        </div>

        <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#0e1521]">
          {packs.map((pack) => (
            <div key={pack.key} className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
              <div className="min-w-0">
                <div className="font-semibold text-slate-900 dark:text-slate-100">{pack.name}</div>
                <div className="font-mono-tabular text-[11px] text-slate-500 dark:text-slate-400">
                  {pack.source.repo} · ветка {pack.source.branch} ·{' '}
                  {pack.source.official ? 'Официальный каталог' : 'Пользовательский'}
                </div>
              </div>
              {!pack.source.official && (
                <button
                  type="button"
                  onClick={() =>
                    void runAction(
                      () => onRemoveRepo(pack.source.repo),
                      `Репозиторий ${pack.source.repo} удалён`
                    )
                  }
                  className="p-1.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded-lg transition-colors"
                  aria-label={`Удалить репозиторий ${pack.source.repo}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* Diagnostics */}
      <section className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Диагностика и журнал
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Экспорт обезличенного JSON-отчёта с конфигурацией Java, последними логами и состоянием
            сборок.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void runAction(async () => {
                const saved = await onExportDiagnostics()
                if (saved) onToast(`Отчёт сохранён: ${saved}`, 'ok')
              })
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <FileArchive className="w-3.5 h-3.5" />
            <span>Экспорт отчёта</span>
          </button>
          <button
            type="button"
            onClick={onOpenConsole}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Открыть консоль</span>
          </button>
        </div>
      </section>
    </div>
  )
}
