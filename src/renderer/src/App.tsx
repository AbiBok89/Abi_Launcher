import { useCallback, useEffect, useState } from 'react'
import type {
  AppInfo,
  CatalogResult,
  ConflictChoice,
  JavaInfoView,
  LogEntry,
  NewsResult,
  ProgressEvent,
  ProfilesState,
  Result,
  ServerStatus,
  Settings
} from '@shared/types'
import type { SystemTheme } from '../../preload/api'
import { CatalogPage } from './pages/CatalogPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { NewsPage } from './pages/NewsPage'
import { ProfilesPage } from './pages/ProfilesPage'
import { ServersPage } from './pages/ServersPage'
import { SettingsPage } from './pages/SettingsPage'

type TabId = 'catalog' | 'downloads' | 'servers' | 'news' | 'profiles' | 'settings'

const TAB_TITLES: Record<TabId, string> = {
  catalog: 'Каталог сборок',
  downloads: 'Загрузки и обновления',
  servers: 'Серверы',
  news: 'Новости',
  profiles: 'Локальные профили',
  settings: 'Настройки и диагностика'
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
      const [infoRes, settingsRes, themeRes, profilesRes, logsRes] = await Promise.all([
        window.abi.getAppInfo(),
        window.abi.getSettings(),
        window.abi.getSystemTheme(),
        window.abi.getProfiles(),
        window.abi.getLogs()
      ])
      if (infoRes.ok) setAppInfo(infoRes.value)
      if (settingsRes.ok) setSettings(settingsRes.value)
      if (themeRes.ok) setSystemTheme(themeRes.value)
      if (profilesRes.ok) setProfiles(profilesRes.value)
      if (logsRes.ok) setLogs(logsRes.value)
      void refreshJava()
      void reloadCatalog()
    })()

    const unsubTheme = window.abi.onSystemThemeChanged((t) => setSystemTheme(t))
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
    const unsubLog = window.abi.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-499), entry])
    })

    return () => {
      unsubTheme()
      unsubProgress()
      unsubState()
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-title">AbiLauncher</div>
            <div className="brand-sub">v{appInfo?.version ?? '0.1.0'}</div>
          </div>
        </div>

        <nav className="nav-list">
          {(
            [
              ['catalog', 'Каталог и сборки', null],
              ['downloads', 'Загрузки', activeOpsCount || updatesCount || null],
              ['servers', 'Серверы', null],
              ['news', 'Новости', null],
              ['profiles', 'Профили', null],
              ['settings', 'Настройки', null]
            ] as Array<[TabId, string, number | null]>
          ).map(([id, label, badge]) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              <span>{label}</span>
              {badge !== null && <span className="nav-badge">{badge}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="profile-pill"
            onClick={() => setTab('profiles')}
          >
            <div>
              <div className="subtle">Активный профиль</div>
              <div style={{ fontWeight: 700 }}>
                {activeProfile ? activeProfile.name : 'Не выбран'}
              </div>
            </div>
            <span className="subtle">→</span>
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">{TAB_TITLES[tab]}</div>
          <div className="topbar-actions">
            {activeOpsCount > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setTab('downloads')}
              >
                Активных операций: {activeOpsCount}
              </button>
            )}
            {settings && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const next =
                    settings.theme === 'system'
                      ? systemTheme === 'dark'
                        ? 'light'
                        : 'dark'
                      : settings.theme === 'dark'
                        ? 'light'
                        : 'system'
                  void updateSettings({ theme: next })
                }}
              >
                Тема:{' '}
                {settings.theme === 'system'
                  ? `Системная (${systemTheme === 'dark' ? 'тёмная' : 'светлая'})`
                  : settings.theme === 'dark'
                    ? 'Тёмная'
                    : 'Светлая'}
              </button>
            )}
          </div>
        </header>

        <main className="content-scroll">
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
              onReloadCatalog={() => void reloadCatalog()}
              onAddRepo={handleAddRepo}
              onCheckPack={handleCheckPack}
              onInstallPack={handleInstallPack}
              onPlayPack={handlePlayPack}
              onCancelOp={(k) => void window.abi.cancelOperation(k)}
              onOpenFolder={(k) => void window.abi.openInstanceFolder(k)}
              onUpdateSettings={updateSettings}
              onPingServer={(h, p) => void pingOneServer(h, p)}
              onGoProfiles={() => setTab('profiles')}
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

          {tab === 'settings' && settings && (
            <SettingsPage
              appInfo={appInfo}
              settings={settings}
              systemTheme={systemTheme}
              javaList={javaList}
              logs={logs}
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
            />
          )}
        </main>
      </div>
    </div>
  )
}
