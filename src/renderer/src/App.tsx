import { useCallback, useEffect, useState, type ComponentType } from 'react'
import type {
  AppInfo,
  CatalogResult,
  ConflictChoice,
  JavaInfoView,
  LauncherUpdateState,
  LogEntry,
  NewsResult,
  ProgressEvent,
  ProfilesState,
  Result,
  ServerStatus,
  Settings
} from '@shared/types'
import type { SystemTheme } from '../../preload/api'
import {
  AbiLogo,
  IconCatalog,
  IconChevronRight,
  IconClose,
  IconDownloads,
  IconMaximize,
  IconMinimize,
  IconMonitor,
  IconMoon,
  IconNews,
  IconProfiles,
  IconRefresh,
  IconRestore,
  IconServers,
  IconSettings,
  IconSun,
  IconTerminal,
  PlayerAvatar
} from './components/Icons'
import { CatalogPage } from './pages/CatalogPage'
import { ConsolePage, type PackCrashInfo } from './pages/ConsolePage'
import { DownloadsPage } from './pages/DownloadsPage'
import { NewsPage } from './pages/NewsPage'
import { ProfilesPage } from './pages/ProfilesPage'
import { ServersPage } from './pages/ServersPage'
import { SettingsPage } from './pages/SettingsPage'

type TabId = 'catalog' | 'downloads' | 'servers' | 'news' | 'profiles' | 'console' | 'settings'

const TAB_TITLES: Record<TabId, string> = {
  catalog: 'Каталог сборок',
  downloads: 'Загрузки и обновления',
  servers: 'Серверы',
  news: 'Новости',
  profiles: 'Локальные профили',
  console: 'Консоль и краш-логи',
  settings: 'Настройки и диагностика'
}

const TAB_ICONS: Record<TabId, ComponentType<{ size?: number; className?: string }>> = {
  catalog: IconCatalog,
  downloads: IconDownloads,
  servers: IconServers,
  news: IconNews,
  profiles: IconProfiles,
  console: IconTerminal,
  settings: IconSettings
}

function unwrap<T>(res: Result<T>): T {
  if (!res.ok) throw new Error(`${res.error.title}: ${res.error.message}`)
  return res.value
}

function serverKey(host: string, port?: number): string {
  return `${host}:${port ?? 25565}`
}

export function App() {
  const [tab, setTab] = useState<TabId>('catalog')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [systemTheme, setSystemTheme] = useState<SystemTheme>('dark')
  const [isMaximized, setIsMaximized] = useState(false)
  const [profiles, setProfiles] = useState<ProfilesState>({ profiles: [], selectedId: null })
  const [catalog, setCatalog] = useState<CatalogResult | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [selectedPackKey, setSelectedPackKey] = useState<string | null>(null)
  const [progressByPack, setProgressByPack] = useState<Record<string, ProgressEvent>>({})
  const [javaList, setJavaList] = useState<JavaInfoView[]>([])
  const [serverStatuses, setServerStatuses] = useState<Record<string, ServerStatus>>({})
  const [pingingServers, setPingingServers] = useState<Record<string, boolean>>({})
  const [news, setNews] = useState<NewsResult | null>(null)
  const [loadingNews, setLoadingNews] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [updateState, setUpdateState] = useState<LauncherUpdateState | null>(null)
  const [lastCrashByPack, setLastCrashByPack] = useState<Record<string, PackCrashInfo>>({})

  // Синхронизируем выбранную тему на корневой элемент документа
  useEffect(() => {
    const effective = !settings || settings.theme === 'system' ? systemTheme : settings.theme
    document.documentElement.setAttribute('data-theme', effective)
  }, [settings, systemTheme])

  const pingOneServer = useCallback(async (host: string, port?: number) => {
    const key = serverKey(host, port)
    setPingingServers((prev) => ({ ...prev, [key]: true }))
    try {
      const status = unwrap(await window.abi.pingServer(host, port))
      setServerStatuses((prev) => ({ ...prev, [key]: status }))
    } catch {
      /* ignore */
    } finally {
      setPingingServers((prev) => ({ ...prev, [key]: false }))
    }
  }, [])

  const reloadNews = useCallback(async () => {
    setLoadingNews(true)
    try {
      const res = unwrap(await window.abi.loadNews())
      setNews(res)
    } catch {
      /* ignore */
    } finally {
      setLoadingNews(false)
    }
  }, [])

  const reloadCatalog = useCallback(async () => {
    setLoadingCatalog(true)
    try {
      const res = unwrap(await window.abi.loadCatalog())
      setCatalog(res)
      if (res.packs.length > 0) {
        setSelectedPackKey((cur) =>
          cur && res.packs.some((p) => p.key === cur) ? cur : res.packs[0].key
        )
        for (const p of res.packs) {
          if (p.server) void pingOneServer(p.server.host, p.server.port)
        }
        void reloadNews()
      }
    } finally {
      setLoadingCatalog(false)
    }
  }, [pingOneServer, reloadNews])

  const refreshJava = useCallback(async () => {
    const list = unwrap(await window.abi.listJava())
    setJavaList(list)
  }, [])

  useEffect(() => {
    void (async () => {
      const [infoRes, settingsRes, themeRes, profilesRes, logsRes, maxRes, updateRes] =
        await Promise.all([
          window.abi.getAppInfo(),
          window.abi.getSettings(),
          window.abi.getSystemTheme(),
          window.abi.getProfiles(),
          window.abi.getLogs(),
          window.abi.windowIsMaximized(),
          window.abi.getLauncherUpdateState()
        ])
      if (infoRes.ok) setAppInfo(infoRes.value)
      if (settingsRes.ok) setSettings(settingsRes.value)
      if (themeRes.ok) setSystemTheme(themeRes.value)
      if (profilesRes.ok) setProfiles(profilesRes.value)
      if (logsRes.ok) setLogs(logsRes.value)
      if (maxRes.ok) setIsMaximized(maxRes.value)
      if (updateRes.ok) setUpdateState(updateRes.value)
      void refreshJava()
      void reloadCatalog()
    })()

    const unsubTheme = window.abi.onSystemThemeChanged((t) => setSystemTheme(t))
    const unsubMax = window.abi.onWindowMaximizedChanged((v) => setIsMaximized(v))
    const unsubUpdater = window.abi.onLauncherUpdateState((st) => setUpdateState(st))
    const unsubProgress = window.abi.onProgress((ev) => {
      setProgressByPack((prev) => ({ ...prev, [ev.packKey]: ev }))
    })
    const unsubState = window.abi.onPackState((ev) => {
      setCatalog((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          packs: prev.packs.map((p) =>
            p.key === ev.packKey
              ? {
                  ...p,
                  status: ev.status,
                  installedVersion: ev.installedVersion,
                  lastError: ev.lastError,
                  conflicts: ev.conflicts,
                  warnings: ev.warnings
                }
              : p
          )
        }
      })
      if (
        ev.status === 'ready' ||
        ev.status === 'error' ||
        ev.status === 'conflict' ||
        ev.status === 'not-installed' ||
        ev.status === 'update-available' ||
        ev.status === 'running'
      ) {
        setProgressByPack((prev) => {
          if (!prev[ev.packKey]) return prev
          const next = { ...prev }
          delete next[ev.packKey]
          return next
        })
      }
    })
    const unsubGame = window.abi.onGameEvent((ev) => {
      if (ev.state === 'started') {
        setLastCrashByPack((prev) => {
          if (!prev[ev.packKey]) return prev
          const next = { ...prev }
          delete next[ev.packKey]
          return next
        })
        return
      }
      if (ev.state === 'exited') {
        const failed = ev.exitCode !== null && ev.exitCode !== undefined && ev.exitCode !== 0
        if (failed || ev.crashReport) {
          setLastCrashByPack((prev) => ({
            ...prev,
            [ev.packKey]: {
              packKey: ev.packKey,
              exitCode: ev.exitCode ?? null,
              crashReport: ev.crashReport ?? null,
              crashReportPath: ev.crashReportPath ?? null,
              ts: new Date().toISOString()
            }
          }))
          if (!ev.crashReport) {
            void window.abi.getLatestCrashReport(ev.packKey).then((res) => {
              if (res.ok && res.value) {
                setLastCrashByPack((prev) => ({
                  ...prev,
                  [ev.packKey]: {
                    ...(prev[ev.packKey] ?? {
                      packKey: ev.packKey,
                      exitCode: ev.exitCode ?? null,
                      crashReportPath: ev.crashReportPath ?? null,
                      ts: new Date().toISOString()
                    }),
                    crashReport: res.value!.content
                  }
                }))
              }
            })
          }
        }
      }
    })
    const unsubLog = window.abi.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-1199), entry])
    })

    return () => {
      unsubTheme()
      unsubMax()
      unsubUpdater()
      unsubProgress()
      unsubState()
      unsubGame()
      unsubLog()
    }
  }, [refreshJava, reloadCatalog])

  const updateSettings = async (patch: Partial<Settings>) => {
    const next = unwrap(await window.abi.updateSettings(patch))
    setSettings(next)
    if (patch.catalogUrl !== undefined || patch.installDir !== undefined) {
      void reloadCatalog()
    }
  }

  const handleAddRepo = async (repo: string, branch?: string) => {
    const nextCatalog = unwrap(await window.abi.addCustomRepo(repo, branch))
    setCatalog(nextCatalog)
    const s = unwrap(await window.abi.getSettings())
    setSettings(s)
    void reloadNews()
  }

  const handleRemoveRepo = async (repo: string) => {
    const nextCatalog = unwrap(await window.abi.removeCustomRepo(repo))
    setCatalog(nextCatalog)
    const s = unwrap(await window.abi.getSettings())
    setSettings(s)
  }

  const handleCheckPack = async (packKey: string) => {
    await window.abi.checkPack(packKey)
  }

  const handleInstallPack = async (
    packKey: string,
    resolutions?: Record<string, ConflictChoice>
  ): Promise<boolean> => {
    const res = await window.abi.installPack(packKey, resolutions)
    return res.ok
  }

  const handlePlayPack = async (
    packKey: string,
    options?: { resolutions?: Record<string, ConflictChoice>; joinServer?: boolean }
  ): Promise<boolean> => {
    const res = await window.abi.playPack(packKey, options)
    return res.ok
  }

  const activeProfile = profiles.profiles.find((p) => p.id === profiles.selectedId) ?? null
  const activeOpsCount = Object.keys(progressByPack).length
  const updatesCount =
    catalog?.packs.filter((p) => p.status === 'update-available').length ?? 0
  const runningPacksCount =
    catalog?.packs.filter((p) => p.status === 'running' || p.status === 'launching').length ?? 0
  const crashCount = Object.keys(lastCrashByPack).length
  const latestMinecraftLogLine = (() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].scope === 'minecraft') return logs[i].message
    }
    return null
  })()
  const hasLauncherUpdate =
    updateState?.phase === 'available' || updateState?.phase === 'downloaded'
  const CurrentTabIcon = TAB_ICONS[tab]
  const ThemeIcon =
    !settings || settings.theme === 'system'
      ? IconMonitor
      : settings.theme === 'dark'
        ? IconMoon
        : IconSun

  const cycleTheme = () => {
    if (!settings) return
    const next =
      settings.theme === 'system'
        ? systemTheme === 'dark'
          ? 'light'
          : 'dark'
        : settings.theme === 'dark'
          ? 'light'
          : 'system'
    void updateSettings({ theme: next })
  }

  return (
    <div className="window-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <AbiLogo size={20} />
          <span className="titlebar-name">AbiLauncher</span>
          <span className="titlebar-ver">v{appInfo?.version ?? '0.1.0'}</span>
        </div>

        <div className="titlebar-right">
          <div className="titlebar-quick">
            {activeOpsCount > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setTab('downloads')}
                title="Открыть текущие загрузки"
              >
                <IconRefresh size={13} className="spin-slow" />
                <span>Операций: {activeOpsCount}</span>
              </button>
            )}
            {settings && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={cycleTheme}
                title="Переключить тему оформления"
              >
                <ThemeIcon size={14} />
                <span>
                  {settings.theme === 'system'
                    ? `Системная (${systemTheme === 'dark' ? 'тёмная' : 'светлая'})`
                    : settings.theme === 'dark'
                      ? 'Тёмная'
                      : 'Светлая'}
                </span>
              </button>
            )}
          </div>

          <div className="window-controls">
            <button
              type="button"
              className="win-btn"
              aria-label="Свернуть окно"
              title="Свернуть"
              onClick={() => void window.abi.windowMinimize()}
            >
              <IconMinimize size={14} />
            </button>
            <button
              type="button"
              className="win-btn"
              aria-label={isMaximized ? 'Восстановить окно' : 'Развернуть окно'}
              title={isMaximized ? 'Восстановить' : 'Развернуть'}
              onClick={() => void window.abi.windowToggleMaximize()}
            >
              {isMaximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
            </button>
            <button
              type="button"
              className="win-btn win-btn-close"
              aria-label="Закрыть лаунчер"
              title="Закрыть"
              onClick={() => void window.abi.windowClose()}
            >
              <IconClose size={14} />
            </button>
          </div>
        </div>
      </header>

      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-section-label">Меню</div>
          <nav className="nav-list">
            {(
              [
                ['catalog', 'Каталог и сборки', null],
                ['downloads', 'Загрузки', activeOpsCount || updatesCount || null],
                ['servers', 'Серверы', null],
                ['news', 'Новости', null],
                ['profiles', 'Профили', null],
                ['console', 'Консоль игры', runningPacksCount || crashCount || null],
                ['settings', 'Настройки', hasLauncherUpdate ? 1 : null]
              ] as Array<[TabId, string, number | null]>
            ).map(([id, label, badge]) => {
              const Icon = TAB_ICONS[id]
              return (
                <button
                  key={id}
                  type="button"
                  className={`nav-item ${tab === id ? 'active' : ''}`}
                  onClick={() => setTab(id)}
                >
                  <span className="nav-item-left">
                    <Icon size={16} />
                    <span>{label}</span>
                  </span>
                  {badge !== null && <span className="nav-badge">{badge}</span>}
                </button>
              )
            })}
          </nav>

          <div className="sidebar-footer">
            <button
              type="button"
              className="profile-pill"
              onClick={() => setTab('profiles')}
              title="Управление профилями игрока"
            >
              <PlayerAvatar name={activeProfile?.name ?? null} size={34} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="subtle" style={{ fontSize: 11 }}>
                  Активный профиль
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {activeProfile ? activeProfile.name : 'Не выбран'}
                </div>
              </div>
              <IconChevronRight size={15} className="subtle" />
            </button>
          </div>
        </aside>

        <div className="main-area">
          <header className="topbar">
            <div className="topbar-title-group">
              <span className="topbar-icon">
                <CurrentTabIcon size={17} />
              </span>
              <h1 className="topbar-title">{TAB_TITLES[tab]}</h1>
            </div>
            <div className="topbar-actions">
              {hasLauncherUpdate && updateState?.latestVersion && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => setTab('settings')}
                >
                  <IconDownloads size={14} />
                  <span>
                    {updateState.phase === 'downloaded'
                      ? `Установить v${updateState.latestVersion}`
                      : `Обновление v${updateState.latestVersion}`}
                  </span>
                </button>
              )}
              {updatesCount > 0 && tab !== 'downloads' && (
                <button
                  type="button"
                  className="btn btn-sm btn-warn"
                  onClick={() => setTab('downloads')}
                >
                  <IconDownloads size={14} />
                  <span>Обновлений: {updatesCount}</span>
                </button>
              )}
              {catalog && catalog.packs.length > 0 && (
                <span className="badge badge-neutral">Сборок: {catalog.packs.length}</span>
              )}
            </div>
          </header>

          <main className="content-scroll">
            <div key={tab} className="view-fade">
          {tab === 'catalog' && (
            <CatalogPage
              catalog={catalog}
              loadingCatalog={loadingCatalog}
              selectedPackKey={selectedPackKey}
              onSelectPack={setSelectedPackKey}
              settings={settings}
              totalMemoryMb={appInfo?.totalMemoryMb ?? 16384}
              profiles={profiles}
              javaList={javaList}
              progressByPack={progressByPack}
              serverStatuses={serverStatuses}
              lastCrashByPack={lastCrashByPack}
              latestMinecraftLogLine={latestMinecraftLogLine}
              onReloadCatalog={() => void reloadCatalog()}
              onAddRepo={handleAddRepo}
              onCheckPack={handleCheckPack}
              onInstallPack={handleInstallPack}
              onPlayPack={handlePlayPack}
              onCancelOp={(k) => void window.abi.cancelOperation(k)}
              onOpenFolder={(k, sub) => void window.abi.openInstanceFolder(k, sub)}
              onUpdateSettings={updateSettings}
              onPingServer={(h, p) => void pingOneServer(h, p)}
              onGoProfiles={() => setTab('profiles')}
              onOpenConsole={() => setTab('console')}
            />
          )}

          {tab === 'downloads' && (
            <DownloadsPage
              packs={catalog?.packs ?? []}
              progressByPack={progressByPack}
              onCheckPack={handleCheckPack}
              onInstallPack={handleInstallPack}
              onPlayPack={handlePlayPack}
              onCancelOp={(k) => void window.abi.cancelOperation(k)}
              onOpenPackPage={(k) => {
                setSelectedPackKey(k)
                setTab('catalog')
              }}
            />
          )}

          {tab === 'servers' && (
            <ServersPage
              packs={catalog?.packs ?? []}
              serverStatuses={serverStatuses}
              pinging={pingingServers}
              onPingAll={() => {
                for (const p of catalog?.packs ?? []) {
                  if (p.server) void pingOneServer(p.server.host, p.server.port)
                }
              }}
              onPingOne={(h, p) => void pingOneServer(h, p)}
              onJoinPlay={(packKey) => {
                setSelectedPackKey(packKey)
                setTab('catalog')
                void handlePlayPack(packKey, { joinServer: true })
              }}
            />
          )}

          {tab === 'news' && (
            <NewsPage
              packs={catalog?.packs ?? []}
              news={news}
              loading={loadingNews}
              onReload={() => void reloadNews()}
              onSelectPack={(key) => {
                setSelectedPackKey(key)
                setTab('catalog')
              }}
            />
          )}

          {tab === 'profiles' && (
            <ProfilesPage
              profiles={profiles}
              onCreate={async (name) => setProfiles(unwrap(await window.abi.createProfile(name)))}
              onRename={async (id, name) =>
                setProfiles(unwrap(await window.abi.renameProfile(id, name)))
              }
              onDelete={async (id) => setProfiles(unwrap(await window.abi.deleteProfile(id)))}
              onSelect={async (id) => setProfiles(unwrap(await window.abi.selectProfile(id)))}
            />
          )}

          {tab === 'console' && (
            <ConsolePage
              packs={catalog?.packs ?? []}
              selectedPackKey={selectedPackKey}
              onSelectPack={setSelectedPackKey}
              logs={logs}
              onClearLogs={() => setLogs([])}
              lastCrashByPack={lastCrashByPack}
              onOpenFolder={(k, sub) => void window.abi.openInstanceFolder(k, sub)}
              onLoadLatestCrashReport={async (k) => unwrap(await window.abi.getLatestCrashReport(k))}
            />
          )}

          {tab === 'settings' && settings && (
            <SettingsPage
              appInfo={appInfo}
              settings={settings}
              systemTheme={systemTheme}
              javaList={javaList}
              logs={logs}
              updateState={updateState}
              onUpdateSettings={updateSettings}
              onPickDirectory={async () => {
                const dir = unwrap(await window.abi.pickDirectory(settings.installDir))
                if (dir) await updateSettings({ installDir: dir })
              }}
              onPickJava={async () => unwrap(await window.abi.pickJavaExecutable())}
              onRefreshJava={refreshJava}
              onTestJava={async (p) => unwrap(await window.abi.testJava(p))}
              onAddRepo={handleAddRepo}
              onRemoveRepo={handleRemoveRepo}
              onExportDiagnostics={async () => unwrap(await window.abi.exportDiagnostics())}
              onCheckUpdate={async () => setUpdateState(unwrap(await window.abi.checkLauncherUpdate()))}
              onDownloadUpdate={async () =>
                setUpdateState(unwrap(await window.abi.downloadLauncherUpdate()))
              }
              onCancelUpdateDownload={async () => {
                unwrap(await window.abi.cancelLauncherUpdateDownload())
              }}
              onInstallUpdate={async () => {
                unwrap(await window.abi.installLauncherUpdate())
              }}
              onOpenReleasePage={async () => {
                unwrap(await window.abi.openLauncherReleasePage())
              }}
              onOpenConsole={() => setTab('console')}
            />
          )}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
