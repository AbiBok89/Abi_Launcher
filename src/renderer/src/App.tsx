import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertTriangle,
  Bug,
  Camera,
  Check,
  Copy,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  Minus,
  Monitor,
  Moon,
  Newspaper,
  Package,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  WifiOff,
  Wrench,
  X
} from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type {
  AppInfo,
  AuthConfig,
  AuthSession,
  CatalogResult,
  ConflictChoice,
  JavaInfoView,
  LauncherUpdateState,
  LogEntry,
  NewsResult,
  PackSubfolder,
  PackView,
  ProfilesState,
  ProgressEvent,
  Result,
  ServerStatus,
  Settings,
  UserError
} from '@shared/types'
import type { SystemTheme } from '../../preload/api'
import { AbiLogo } from './components/AbiLogo'
import { AddRepoModal } from './components/AddRepoModal'
import { ConflictModal } from './components/ConflictModal'
import { ConsoleDrawer, type PackCrashInfo } from './components/ConsoleDrawer'
import { DownloadsDrawer, type CompletedTaskItem } from './components/DownloadsDrawer'
import { ErrorBanner } from './components/ErrorBanner'
import { AllServersView, GlobalSettingsView } from './components/GlobalViews'
import { MarkdownContent } from './components/MarkdownContent'
import { MemoryAllocationBar } from './components/MemoryAllocationBar'
import { PackContentManager } from './components/PackContentManager'
import { PackCover } from './components/PackCover'
import { AuthAccountCard } from './components/AuthAccountCard'
import { AuthLoginModal } from './components/AuthLoginModal'
import { PreflightCard, type PackPreflightStatus } from './components/PreflightCard'
import { Tooltip } from './components/Tooltip'
import {
  STAGE_LABELS,
  STATUS_LABELS,
  formatBytes,
  formatDateRu,
  formatLoader,
  formatMemoryGb,
  formatPackVersion,
  formatServerAddress,
  formatSpeed,
  requiredJavaMajorForMinecraft
} from './utils/format'

type MainView = 'pack' | 'servers' | 'settings'
type PackSubTab = 'overview' | 'news' | 'settings' | 'files'

interface ToastItem {
  id: string
  message: string
  tone: 'info' | 'ok' | 'warn'
}

function unwrap<T>(res: Result<T>): T {
  if (!res.ok) throw new Error(`${res.error.title}: ${res.error.message}`)
  return res.value
}

function serverKey(host: string, port?: number): string {
  return `${host}:${port ?? 25565}`
}

function isAllowed20tpsHost(host?: string | null): boolean {
  if (!host) return false
  const clean = host.trim().replace(/\.+$/, '').toLowerCase()
  return clean.endsWith('.20tps.ru') && clean.length > '.20tps.ru'.length
}

export function App() {
  const [mainView, setMainView] = useState<MainView>('pack')
  const [packTab, setPackTab] = useState<PackSubTab>('overview')
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [addRepoOpen, setAddRepoOpen] = useState(false)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    siteUrl: 'https://hm575903.webhm.cloud',
    yggdrasilUrl: 'https://hm575903.webhm.cloud/api/yggdrasil'
  })
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [conflictModal, setConflictModal] = useState<{
    packKey: string
    mode: 'install' | 'play'
  } | null>(null)

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [systemTheme, setSystemTheme] = useState<SystemTheme>('dark')
  const [catalog, setCatalog] = useState<CatalogResult | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [selectedPackKey, setSelectedPackKey] = useState<string | null>(null)
  const [progressByPack, setProgressByPack] = useState<Record<string, ProgressEvent>>({})
  const [completedTasks, setCompletedTasks] = useState<CompletedTaskItem[]>([])
  const [javaList, setJavaList] = useState<JavaInfoView[]>([])
  const [serverStatuses, setServerStatuses] = useState<Record<string, ServerStatus>>({})
  const [pingingServers, setPingingServers] = useState<Record<string, boolean>>({})
  const [news, setNews] = useState<NewsResult | null>(null)
  const [loadingNews, setLoadingNews] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [updateState, setUpdateState] = useState<LauncherUpdateState | null>(null)
  const [lastCrashByPack, setLastCrashByPack] = useState<Record<string, PackCrashInfo>>({})
  const [actionError, setActionError] = useState<UserError | null>(null)
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
  const [packJvmInput, setPackJvmInput] = useState('')
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const packsRef = useRef<PackView[]>([])
  const progressRef = useRef<Record<string, ProgressEvent>>({})

  const pushToast = useCallback((message: string, tone: 'info' | 'ok' | 'warn' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3400)
  }, [])

  // Sync theme to documentElement (both .dark class for Tailwind v4 and data-theme)
  useEffect(() => {
    const effective = !settings || settings.theme === 'system' ? systemTheme : settings.theme
    document.documentElement.setAttribute('data-theme', effective)
    document.documentElement.classList.toggle('dark', effective === 'dark')
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
      packsRef.current = res.packs
      if (res.packs.length > 0) {
        setSelectedPackKey((cur) =>
          cur && res.packs.some((p) => p.key === cur) ? cur : res.packs[0].key
        )
        for (const p of res.packs) {
          if (p.server && isAllowed20tpsHost(p.server.host)) {
            void pingOneServer(p.server.host, p.server.port)
          }
        }
        void reloadNews()
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'warn')
    } finally {
      setLoadingCatalog(false)
    }
  }, [pingOneServer, pushToast, reloadNews])

  const refreshJava = useCallback(async () => {
    const list = unwrap(await window.abi.listJava())
    setJavaList(list)
  }, [])

  useEffect(() => {
    void (async () => {
      const [infoRes, settingsRes, themeRes, logsRes, updateRes, authCfgRes, authRes] =
        await Promise.all([
          window.abi.getAppInfo(),
          window.abi.getSettings(),
          window.abi.getSystemTheme(),
          window.abi.getLogs(),
          window.abi.getLauncherUpdateState(),
          window.abi.getAuthConfig(),
          window.abi.authValidateOrRefresh()
        ])
      if (infoRes.ok) setAppInfo(infoRes.value)
      if (settingsRes.ok) setSettings(settingsRes.value)
      if (themeRes.ok) setSystemTheme(themeRes.value)
      if (logsRes.ok) setLogs(logsRes.value)
      if (updateRes.ok) setUpdateState(updateRes.value)
      if (authCfgRes.ok) setAuthConfig(authCfgRes.value)
      if (authRes.ok) {
        setAuthSession(authRes.value)
        if (!authRes.value) {
          setAuthModalOpen(true)
        }
      } else {
        setAuthModalOpen(true)
      }
      void refreshJava()
      void reloadCatalog()
    })()

    const unsubTheme = window.abi.onSystemThemeChanged((t) => setSystemTheme(t))
    const unsubUpdater = window.abi.onLauncherUpdateState((st) => {
      setUpdateState(st)
      if (st.phase === 'installing') {
        pushToast(`Устанавливается обновление v${st.latestVersion ?? ''} — перезапуск…`, 'ok')
      }
    })
    const unsubProgress = window.abi.onProgress((ev) => {
      progressRef.current = { ...progressRef.current, [ev.packKey]: ev }
      setProgressByPack((prev) => ({ ...prev, [ev.packKey]: ev }))
    })
    const unsubState = window.abi.onPackState((ev) => {
      setCatalog((prev) => {
        if (!prev) return prev
        const nextPacks = prev.packs.map((p) =>
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
        packsRef.current = nextPacks
        return { ...prev, packs: nextPacks }
      })

      if (
        ev.status === 'ready' ||
        ev.status === 'error' ||
        ev.status === 'conflict' ||
        ev.status === 'not-installed' ||
        ev.status === 'update-available' ||
        ev.status === 'running'
      ) {
        const hadOp = progressRef.current[ev.packKey]
        if (hadOp && (ev.status === 'ready' || ev.status === 'error' || ev.status === 'running')) {
          const packName =
            packsRef.current.find((p) => p.key === ev.packKey)?.name ?? ev.packKey
          const actionText =
            ev.status === 'error'
              ? ev.lastError?.title ?? 'Ошибка операции'
              : hadOp.operation === 'install'
                ? 'Установка / обновление завершено'
                : hadOp.operation === 'verify'
                  ? 'Проверка файлов завершена'
                  : 'Игра запущена'
          setCompletedTasks((prev) => [
            {
              id: `${Date.now()}-${ev.packKey}`,
              packName,
              action: actionText,
              finishedAt: new Date().toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit'
              }),
              status: ev.status === 'error' ? 'error' : 'ok'
            },
            ...prev.slice(0, 14)
          ])
        }

        if (hadOp) {
          const nextProg = { ...progressRef.current }
          delete nextProg[ev.packKey]
          progressRef.current = nextProg
          setProgressByPack((prev) => {
            if (!prev[ev.packKey]) return prev
            const copy = { ...prev }
            delete copy[ev.packKey]
            return copy
          })
        }
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
      unsubUpdater()
      unsubProgress()
      unsubState()
      unsubGame()
      unsubLog()
    }
  }, [refreshJava, reloadCatalog])

  const packs = catalog?.packs ?? []
  const selected = useMemo(
    () => packs.find((p) => p.key === selectedPackKey) ?? packs[0] ?? null,
    [packs, selectedPackKey]
  )

  const selectedOverride = selected && settings ? settings.packOverrides[selected.key] : undefined

  useEffect(() => {
    setPackJvmInput(selectedOverride?.extraJvmArgs ?? '')
  }, [selected?.key, selectedOverride?.extraJvmArgs])

  const activeProfile = useMemo(
    () =>
      authSession
        ? {
            id: authSession.uuid,
            name: authSession.username,
            uuid: authSession.uuid,
            createdAt: ''
          }
        : null,
    [authSession]
  )

  const systemMemMb = appInfo?.totalMemoryMb ?? 16384
  const sliderMaxMb = Math.max(4096, Math.min(32768, Math.floor(systemMemMb / 512) * 512))

  const updateSettings = async (patch: Partial<Settings>) => {
    const next = unwrap(await window.abi.updateSettings(patch))
    setSettings(next)
    if (patch.catalogUrl !== undefined || patch.installDir !== undefined) {
      void reloadCatalog()
    }
  }

  const updatePackOverride = async (
    packKey: string,
    patch: { memoryMb?: number | null; javaPath?: string | null; extraJvmArgs?: string | null }
  ) => {
    if (!settings) return
    const current = settings.packOverrides[packKey] ?? {}
    await updateSettings({
      packOverrides: {
        ...settings.packOverrides,
        [packKey]: { ...current, ...patch }
      }
    })
  }

  const resetPackOverrides = async (packKey: string) => {
    if (!settings) return
    const nextOverrides = { ...settings.packOverrides }
    delete nextOverrides[packKey]
    await updateSettings({ packOverrides: nextOverrides })
    pushToast('Параметры сборки сброшены к общим', 'info')
  }

  // Compute real pre-flight status for selected pack
  const selectedPreflight: PackPreflightStatus | null = useMemo(() => {
    if (!selected || !settings) return null
    const requiredJavaMajor = requiredJavaMajorForMinecraft(selected.minecraft)
    const activeJavaPath = selectedOverride?.javaPath ?? settings.javaPath ?? null
    const matchedActiveJava = activeJavaPath
      ? javaList.find((j) => j.path === activeJavaPath) ?? null
      : null
    const isAutoJava = !activeJavaPath
    const javaOk = isAutoJava || (matchedActiveJava ? matchedActiveJava.majorVersion === requiredJavaMajor : true)

    const recommendedJava =
      javaList.find((j) => j.majorVersion === requiredJavaMajor && j.managed) ??
      javaList.find((j) => j.majorVersion === requiredJavaMajor) ??
      null

    const defaultEffectiveMem =
      settings.defaultMemoryMb ??
      Math.min(selected.recommendedMemoryMb, Math.max(2048, systemMemMb - 2048))
    const activeMemoryMb = selectedOverride?.memoryMb ?? defaultEffectiveMem
    const safeRecommendedMem = Math.min(
      selected.recommendedMemoryMb,
      Math.max(2048, Math.floor((systemMemMb - 2048) / 512) * 512)
    )
    const memoryOk = activeMemoryMb >= safeRecommendedMem
    const profileOk = Boolean(activeProfile)

    return {
      requiredJavaMajor,
      activeJavaMajor: matchedActiveJava?.majorVersion ?? null,
      isAutoJava,
      recommendedJavaPath: recommendedJava?.path ?? null,
      recommendedJavaLabel: recommendedJava
        ? `Java ${recommendedJava.majorVersion} (${recommendedJava.version})`
        : null,
      javaOk,
      recommendedMemoryMb: safeRecommendedMem,
      activeMemoryMb,
      systemMemoryMb: systemMemMb,
      memoryOk,
      profileOk,
      allReady: javaOk && memoryOk && profileOk
    }
  }, [activeProfile, javaList, selected, selectedOverride, settings, systemMemMb])

  const applyPreflightFix = async (packKey: string, mode: 'java' | 'memory' | 'all') => {
    if (!selectedPreflight || !selected || selected.key !== packKey) return
    const patch: { memoryMb?: number | null; javaPath?: string | null } = {}
    if (mode === 'java' || mode === 'all') {
      patch.javaPath = selectedPreflight.recommendedJavaPath ?? null
    }
    if (mode === 'memory' || mode === 'all') {
      patch.memoryMb = selectedPreflight.recommendedMemoryMb
    }
    await updatePackOverride(packKey, patch)
    if (mode === 'all') {
      pushToast(
        `Для «${selected.name}» настроены Java ${selectedPreflight.requiredJavaMajor} и ${formatMemoryGb(selectedPreflight.recommendedMemoryMb)} ОЗУ`,
        'ok'
      )
    } else if (mode === 'java') {
      pushToast(`Для «${selected.name}» выбрана Java ${selectedPreflight.requiredJavaMajor}`, 'ok')
    } else {
      pushToast(
        `Для «${selected.name}» выделено ${formatMemoryGb(selectedPreflight.recommendedMemoryMb)} ОЗУ`,
        'ok'
      )
    }
  }

  const handleAddRepo = async (repo: string, branch?: string) => {
    unwrap(await window.abi.addCustomRepo(repo, branch))
    const s = unwrap(await window.abi.getSettings())
    setSettings(s)
    await reloadCatalog()
    pushToast(`Репозиторий ${repo} добавлен`, 'ok')
  }

  const handleRemoveRepo = async (repo: string) => {
    unwrap(await window.abi.removeCustomRepo(repo))
    const s = unwrap(await window.abi.getSettings())
    setSettings(s)
    await reloadCatalog()
  }

  const handleCheckPack = async (packKey: string) => {
    setActionError(null)
    const res = await window.abi.checkPack(packKey)
    if (!res.ok) {
      setActionError(res.error)
    } else {
      pushToast('Проверка файлов завершена', 'ok')
    }
  }

  const handleInstallPack = async (
    packKey: string,
    resolutions?: Record<string, ConflictChoice>
  ): Promise<boolean> => {
    setActionError(null)
    const res = await window.abi.installPack(packKey, resolutions)
    if (!res.ok) {
      if (res.error.code === 'conflict') {
        setConflictModal({ packKey, mode: 'install' })
      } else {
        setActionError(res.error)
      }
      return false
    }
    return true
  }

  const handlePlayPack = async (
    packKey: string,
    options?: { resolutions?: Record<string, ConflictChoice>; joinServer?: boolean }
  ): Promise<boolean> => {
    setActionError(null)
    const res = await window.abi.playPack(packKey, options)
    if (!res.ok) {
      if (res.error.code === 'conflict') {
        setConflictModal({ packKey, mode: 'play' })
      } else if (res.error.code === 'no-profile') {
        setAuthModalOpen(true)
        pushToast('Войдите в аккаунт перед запуском игры', 'warn')
      } else {
        setActionError(res.error)
      }
      return false
    }
    return true
  }

  const handlePrimaryAction = async (pack: PackView, joinServer = false) => {
    setActionError(null)
    if (pack.status === 'checking' || pack.status === 'downloading' || pack.status === 'launching') {
      return
    }
    if (pack.status === 'running') {
      setConsoleOpen(true)
      return
    }
    if (pack.status === 'conflict') {
      setConflictModal({ packKey: pack.key, mode: pack.installedVersion ? 'play' : 'install' })
      return
    }
    if (!pack.installedVersion) {
      await handleInstallPack(pack.key)
      return
    }
    if (!activeProfile) {
      setAuthModalOpen(true)
      pushToast('Войдите в аккаунт перед запуском игры', 'warn')
      return
    }
    await handlePlayPack(pack.key, joinServer ? { joinServer: true } : undefined)
  }

  const handleOpenFolder = (packKey: string, subfolder?: PackSubfolder) => {
    void window.abi.openInstanceFolder(packKey, subfolder).then((res) => {
      if (!res.ok) pushToast(res.error.message, 'warn')
    })
  }

  const handleCopyAddress = (addr: string) => {
    navigator.clipboard?.writeText(addr).catch(() => undefined)
    setCopiedAddr(addr)
    pushToast(`IP ${addr} скопирован в буфер`, 'info')
    window.setTimeout(() => setCopiedAddr((cur) => (cur === addr ? null : cur)), 1600)
  }

  const cycleTheme = () => {
    if (!settings) return
    const next =
      settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark'
    void updateSettings({ theme: next })
  }

  const ThemeIcon =
    !settings || settings.theme === 'system'
      ? Monitor
      : settings.theme === 'dark'
        ? Moon
        : Sun

  const activeOpsCount = Object.keys(progressByPack).length
  const updatesCount = packs.filter(
    (p) => p.status === 'update-available' || p.status === 'conflict'
  ).length
  const runningCount = packs.filter(
    (p) => p.status === 'running' || p.status === 'launching'
  ).length
  const crashes = Object.values(lastCrashByPack)
  const hasLauncherUpdate =
    updateState?.phase === 'available' ||
    updateState?.phase === 'downloading' ||
    updateState?.phase === 'downloaded' ||
    updateState?.phase === 'installing'
  const updatePct =
    updateState && updateState.progressBytesTotal > 0
      ? Math.min(
          100,
          Math.round((updateState.progressBytesDone / updateState.progressBytesTotal) * 100)
        )
      : 0

  const packNews = useMemo(
    () => (selected && news ? news.items.filter((n) => n.packKey === selected.key) : []),
    [news, selected]
  )

  const selectedProgress = selected ? progressByPack[selected.key] : undefined
  const selectedIsBusy =
    selected !== null &&
    (selected.status === 'checking' ||
      selected.status === 'downloading' ||
      selected.status === 'launching' ||
      selected.status === 'running')

  const effectiveMemoryMb =
    selectedOverride?.memoryMb ??
    settings?.defaultMemoryMb ??
    selected?.recommendedMemoryMb ??
    8192
  const hasAnyOverride = Boolean(
    selectedOverride?.memoryMb || selectedOverride?.javaPath || selectedOverride?.extraJvmArgs
  )

  const primaryLabel = (pack: PackView) => {
    switch (pack.status) {
      case 'not-installed':
        return 'Установить сборку'
      case 'checking':
        return 'Проверка…'
      case 'downloading':
        return 'Загрузка…'
      case 'update-available':
        return 'Обновить и играть'
      case 'conflict':
        return 'Решить конфликты'
      case 'launching':
        return 'Запуск игры…'
      case 'running':
        return 'Игра запущена'
      case 'error':
        return 'Повторить'
      case 'ready':
        return 'Играть'
    }
  }

  const statusToneClass = (status: PackView['status']) => {
    switch (status) {
      case 'ready':
      case 'running':
        return 'text-emerald-700 dark:text-emerald-400'
      case 'update-available':
      case 'conflict':
        return 'text-amber-700 dark:text-amber-400'
      case 'downloading':
      case 'checking':
      case 'launching':
        return 'text-sky-700 dark:text-sky-400'
      case 'error':
        return 'text-rose-700 dark:text-rose-400'
      default:
        return 'text-slate-500 dark:text-slate-400'
    }
  }

  const conflictPack = conflictModal
    ? packs.find((p) => p.key === conflictModal.packKey) ?? null
    : null

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col h-screen w-screen bg-[#edf2f8] dark:bg-[#080c12] text-slate-900 dark:text-slate-100 overflow-hidden relative">
        {/* Frameless Desktop Titlebar */}
        <header
          data-tauri-drag-region
          className="titlebar-drag h-11 pl-4 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800/90 bg-white/95 dark:bg-[#0b1019]/95 shrink-0 z-40"
        >
          <div data-tauri-drag-region className="flex items-center gap-2.5 min-w-0">
            <AbiLogo size={24} />
            <span
              data-tauri-drag-region
              className="font-display text-sm font-bold tracking-tight whitespace-nowrap shrink-0"
            >
              AbiLauncher
            </span>
            <span
              data-tauri-drag-region
              className="text-xs font-mono-tabular text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0"
            >
              v{appInfo?.version ?? '0.4.0'}
            </span>
            {(updateState?.phase === 'downloading' || updateState?.phase === 'installing') && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-600/12 dark:bg-emerald-500/15 text-[11px] font-mono-tabular font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap shrink-0">
                <Loader2 className="w-3 h-3 animate-spin" />
                {updateState.phase === 'installing'
                  ? `Установка v${updateState.latestVersion ?? ''}…`
                  : `Обновление v${updateState.latestVersion ?? ''}: ${updatePct}%`}
              </span>
            )}
          </div>

          <div className="titlebar-no-drag flex items-center h-full">
            <div className="flex items-center gap-1 pr-2">
              <button
                type="button"
                onClick={() => setDownloadsOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  downloadsOpen
                    ? 'bg-emerald-600/12 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80'
                }`}
                title="Открыть выдвижную панель загрузок"
              >
                {activeOpsCount > 0 ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>Загрузки</span>
                {(activeOpsCount > 0 || updatesCount > 0) && (
                  <span className="font-mono-tabular text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    ({activeOpsCount > 0 ? activeOpsCount : updatesCount})
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setConsoleOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  consoleOpen
                    ? 'bg-emerald-600/12 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : crashes.length > 0
                      ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-500/10'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80'
                }`}
                title="Открыть выдвижную консоль игры"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Консоль</span>
                {(runningCount > 0 || crashes.length > 0) && (
                  <span
                    className={`font-mono-tabular text-[11px] font-semibold ${
                      crashes.length > 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    · {crashes.length > 0 ? 'краш' : 'активна'}
                  </span>
                )}
              </button>

              <span className="h-4 w-px bg-slate-200 dark:bg-slate-800 mx-1" aria-hidden="true" />

              {settings && (
                <button
                  type="button"
                  onClick={cycleTheme}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors whitespace-nowrap shrink-0"
                  title="Переключить тему оформления"
                >
                  <ThemeIcon className="w-3.5 h-3.5" />
                  <span>
                    {settings.theme === 'dark'
                      ? 'Тёмная'
                      : settings.theme === 'light'
                        ? 'Светлая'
                        : 'Системная'}
                  </span>
                </button>
              )}
            </div>

            {/* Native window controls */}
            <div className="flex items-stretch h-full border-l border-slate-200 dark:border-slate-800/80">
              <button
                type="button"
                aria-label="Свернуть окно"
                title="Свернуть"
                onClick={() => void window.abi.windowMinimize()}
                className="w-11 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              {settings?.resizableWindow && (
                <button
                  type="button"
                  aria-label="Развернуть или восстановить окно"
                  title="Развернуть / Восстановить"
                  onClick={() => void window.abi.windowToggleMaximize()}
                  className="w-11 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
                >
                  <Square className="w-3 h-3" />
                </button>
              )}
              <button
                type="button"
                aria-label="Закрыть лаунчер"
                title="Закрыть"
                onClick={() => void window.abi.windowClose()}
                className="w-11 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-rose-600 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Main Split Body */}
        <div className="flex flex-1 min-h-0 relative">
          {/* Left Pack-First Sidebar */}
          <aside className="w-[264px] shrink-0 border-r border-slate-200 dark:border-slate-800/90 bg-white/80 dark:bg-[#0b111c] flex flex-col">
            <div className="px-4 pt-4 pb-2.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Мои сборки ({packs.length})
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void reloadCatalog()}
                  disabled={loadingCatalog}
                  title="Обновить каталог из GitHub"
                  aria-label="Обновить каталог"
                  className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingCatalog ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setAddRepoOpen(true)}
                  title="Добавить сборку по ссылке GitHub"
                  aria-label="Добавить сборку по ссылке GitHub"
                  className="p-1.5 rounded-md text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Pack List */}
            <nav className="flex-1 overflow-y-auto px-2.5 space-y-1" aria-label="Библиотека сборок">
              {packs.length === 0 && loadingCatalog && (
                <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400 flex flex-col items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
                  <span>Загрузка каталога…</span>
                </div>
              )}

              {packs.map((pack) => {
                const isSelected = mainView === 'pack' && selected?.key === pack.key
                const op = progressByPack[pack.key]
                const opPct =
                  op && op.bytesTotal > 0
                    ? Math.min(100, Math.round((op.bytesDone / op.bytesTotal) * 100))
                    : null

                return (
                  <button
                    key={pack.key}
                    type="button"
                    onClick={() => {
                      setActionError(null)
                      setSelectedPackKey(pack.key)
                      setMainView('pack')
                    }}
                    className={`w-full text-left p-2.5 rounded-lg transition-colors flex items-start gap-3 ${
                      isSelected
                        ? 'bg-emerald-600/12 dark:bg-emerald-500/14 text-slate-950 dark:text-white'
                        : 'hover:bg-slate-200/60 dark:hover:bg-slate-800/60 text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <PackCover
                      src={pack.coverDataUrl}
                      alt={pack.name}
                      name={pack.name}
                      className="w-11 h-11 rounded-md shrink-0 border border-slate-300/60 dark:border-slate-700/70"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-xs font-bold truncate leading-snug">{pack.name}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate font-mono-tabular">
                        {pack.installedVersion
                          ? formatPackVersion(pack.installedVersion)
                          : formatPackVersion(pack.version)}
                      </div>
                      <div
                        title={
                          pack.status === 'update-available'
                            ? `Доступна версия ${formatPackVersion(pack.version)}`
                            : undefined
                        }
                        className={`text-[11px] font-medium truncate ${statusToneClass(pack.status)}`}
                      >
                        {op
                          ? opPct !== null
                            ? `${STAGE_LABELS[op.stage]} ${opPct}%`
                            : STAGE_LABELS[op.stage]
                          : pack.status === 'conflict'
                            ? `Конфликт (${pack.conflicts.length})`
                            : STATUS_LABELS[pack.status].label}
                      </div>
                      {op && (
                        <div className="h-1 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden mt-1">
                          <div
                            className={`h-full bg-emerald-500 transition-[width] duration-200 ${
                              opPct === null ? 'w-1/3 animate-pulse' : ''
                            }`}
                            style={opPct !== null ? { width: `${opPct}%` } : undefined}
                          />
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}

              <button
                type="button"
                onClick={() => setAddRepoOpen(true)}
                className="w-full mt-2 px-3 py-2.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700/80 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-500/50 transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Подключить репозиторий</span>
              </button>
            </nav>

            {/* Bottom Global Utilities */}
            <div className="p-2.5 border-t border-slate-200 dark:border-slate-800/90 space-y-1">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setMainView('servers')}
                  className={`flex-1 min-w-0 px-2.5 py-2 rounded-lg text-xs font-medium flex items-center justify-between gap-2 transition-colors ${
                    mainView === 'servers'
                      ? 'bg-emerald-600/12 dark:bg-emerald-500/14 text-emerald-800 dark:text-emerald-300 font-semibold'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="inline-flex items-center gap-2 truncate">
                    <Server className="w-4 h-4 shrink-0" />
                    <span className="truncate">Все серверы</span>
                  </span>
                  <span className="font-mono-tabular text-[11px] text-slate-400 shrink-0">
                    {packs.filter((p) => p.server && isAllowed20tpsHost(p.server.host)).length}
                  </span>
                </button>

                <Tooltip content="Discord-сервер" compact>
                  <button
                    type="button"
                    aria-label="Discord"
                    onClick={() => {
                      void openUrl('https://discord.gg/s7uSGhvaky').catch(() => {
                        window.open('https://discord.gg/s7uSGhvaky', '_blank', 'noopener,noreferrer')
                      })
                    }}
                    className="w-8 h-8 shrink-0 rounded-lg border border-slate-200/80 dark:border-slate-800/90 bg-slate-100/70 dark:bg-slate-900/60 text-slate-600 dark:text-slate-300 hover:border-[#5865F2]/50 hover:bg-[#5865F2]/12 hover:text-[#5865F2] dark:hover:text-[#7984F5] flex items-center justify-center transition-colors"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                    </svg>
                  </button>
                </Tooltip>

                <Tooltip content="Telegram-канал" compact>
                  <button
                    type="button"
                    aria-label="Telegram"
                    onClick={() => {
                      void openUrl('https://t.me/AbiBok_TFG').catch(() => {
                        window.open('https://t.me/AbiBok_TFG', '_blank', 'noopener,noreferrer')
                      })
                    }}
                    className="w-8 h-8 shrink-0 rounded-lg border border-slate-200/80 dark:border-slate-800/90 bg-slate-100/70 dark:bg-slate-900/60 text-slate-600 dark:text-slate-300 hover:border-[#229ED9]/50 hover:bg-[#229ED9]/12 hover:text-[#229ED9] dark:hover:text-[#38BDF8] flex items-center justify-center transition-colors"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                    </svg>
                  </button>
                </Tooltip>
              </div>

              <button
                type="button"
                onClick={() => setMainView('settings')}
                className={`w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                  mainView === 'settings'
                    ? 'bg-emerald-600/12 dark:bg-emerald-500/14 text-emerald-800 dark:text-emerald-300 font-semibold'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <SettingsIcon className="w-4 h-4 shrink-0" />
                  <span>Настройки</span>
                </span>
                {hasLauncherUpdate && updateState?.latestVersion && (
                  <span className="text-[11px] font-mono-tabular font-medium text-emerald-700 dark:text-emerald-400">
                    v{updateState.latestVersion}
                  </span>
                )}
              </button>

              <div className="pt-1.5 mt-1 border-t border-slate-200/80 dark:border-slate-800/80">
                <AuthAccountCard
                  session={authSession}
                  siteUrl={authConfig.siteUrl}
                  onOpenLogin={() => setAuthModalOpen(true)}
                  onLogout={async () => {
                    await window.abi.authLogout()
                    setAuthSession(null)
                    pushToast('Вы вышли из аккаунта', 'info')
                  }}
                  onOpenSitePage={(pagePath) => {
                    void window.abi.authOpenSitePage(pagePath)
                  }}
                />
              </div>
            </div>
          </aside>

          {/* Main Viewport */}
          <main className="flex-1 min-w-0 flex flex-col bg-[#f5f8fc] dark:bg-[#080c12]">
            {mainView === 'servers' && (
              <div className="flex-1 overflow-y-auto">
                <AllServersView
                  packs={packs}
                  serverStatuses={serverStatuses}
                  pingingServers={pingingServers}
                  onPingServer={(h, p) => void pingOneServer(h, p)}
                  onJoinPack={(packKey) => {
                    setSelectedPackKey(packKey)
                    setMainView('pack')
                    const target = packs.find((p) => p.key === packKey)
                    if (target) void handlePrimaryAction(target, true)
                  }}
                  onToast={pushToast}
                />
              </div>
            )}

            {mainView === 'settings' && settings && (
              <div className="flex-1 overflow-y-auto">
                <GlobalSettingsView
                  appInfo={appInfo}
                  settings={settings}
                  systemTheme={systemTheme}
                  packs={packs}
                  javaList={javaList}
                  updateState={updateState}
                  onUpdateSettings={updateSettings}
                  onPickDirectory={async () => {
                    const dir = unwrap(await window.abi.pickDirectory(settings.installDir))
                    if (dir) await updateSettings({ installDir: dir })
                  }}
                  onPickJava={async () => unwrap(await window.abi.pickJavaExecutable())}
                  onRefreshJava={refreshJava}
                  onTestJava={async (p) => unwrap(await window.abi.testJava(p))}
                  onOpenAddRepo={() => setAddRepoOpen(true)}
                  onRemoveRepo={handleRemoveRepo}
                  onExportDiagnostics={async () => unwrap(await window.abi.exportDiagnostics())}
                  onCheckUpdate={async () =>
                    setUpdateState(unwrap(await window.abi.checkLauncherUpdate()))
                  }
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
                  onOpenConsole={() => setConsoleOpen(true)}
                  onToast={pushToast}
                />
              </div>
            )}

            {mainView === 'pack' && !selected && (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="max-w-md text-center space-y-4">
                  <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                    {loadingCatalog ? 'Загружаем каталог сборок…' : 'Каталог сборок пуст'}
                  </h2>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {loadingCatalog
                      ? 'Подключаемся к GitHub для получения списка сборок AbiLauncher.'
                      : 'Проверьте подключение к интернету, адрес каталога в настройках или подключите репозиторий сборки вручную.'}
                  </p>
                  {!loadingCatalog && (
                    <div className="flex items-center justify-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => void reloadCatalog()}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Повторить</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddRepoOpen(true)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Добавить репозиторий</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {mainView === 'pack' && selected && (
              <>
                <div className="flex-1 overflow-y-auto">
                  {/* Atmospheric Pack Hero Header */}
                  <div className="relative h-48 w-full overflow-hidden border-b border-slate-200 dark:border-slate-800">
                    <PackCover
                      src={selected.coverDataUrl}
                      alt={`Обложка сборки ${selected.name}`}
                      name={selected.name}
                      className="w-full h-full"
                    />
                    <div
                      className="absolute inset-0 bg-gradient-to-t from-[#070b11] via-[#070b11]/65 to-[#070b11]/20"
                      aria-hidden="true"
                    />
                    <div className="absolute inset-0 p-6 flex flex-col justify-end">
                      <div className="max-w-3xl space-y-2">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-300 font-mono-tabular">
                          <span>Версия {selected.version}</span>
                          <span aria-hidden="true">·</span>
                          <span>MC {selected.minecraft}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatLoader(selected.loader)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{selected.source.repo}</span>
                        </div>

                        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight leading-tight">
                          {selected.name}
                        </h1>

                        {selected.summary && (
                          <p className="text-xs sm:text-sm text-slate-200/90 max-w-2xl line-clamp-2">
                            {selected.summary}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Live Operation Strip */}
                  {selectedProgress && (
                    <div className="px-6 py-3 bg-emerald-600/[0.08] dark:bg-emerald-500/[0.1] border-b border-emerald-500/20 flex flex-wrap items-center justify-between gap-4">
                      {(() => {
                        const pct =
                          selectedProgress.bytesTotal > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (selectedProgress.bytesDone / selectedProgress.bytesTotal) * 100
                                )
                              )
                            : null
                        return (
                          <>
                            <div className="flex-1 min-w-[220px] space-y-1.5">
                              <div className="flex items-center justify-between text-xs gap-2">
                                <span className="font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5 truncate">
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
                                  <span className="truncate">
                                    {STAGE_LABELS[selectedProgress.stage]} — {selectedProgress.label}
                                  </span>
                                </span>
                                <span className="font-mono-tabular text-emerald-700 dark:text-emerald-400 font-semibold whitespace-nowrap shrink-0">
                                  {pct !== null ? `${pct}%` : '…'}
                                  {selectedProgress.speed > 0
                                    ? ` · ${formatSpeed(selectedProgress.speed)}`
                                    : ''}
                                </span>
                              </div>
                              <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                                <div
                                  className={`h-full bg-emerald-600 dark:bg-emerald-500 transition-[width] duration-200 ${
                                    pct === null ? 'w-1/3 animate-pulse' : ''
                                  }`}
                                  style={pct !== null ? { width: `${pct}%` } : undefined}
                                />
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-xs font-mono-tabular text-slate-600 dark:text-slate-400">
                                {selectedProgress.bytesTotal > 0
                                  ? `${formatBytes(selectedProgress.bytesDone)} / ${formatBytes(selectedProgress.bytesTotal)}`
                                  : selectedProgress.filesTotal > 0
                                    ? `${selectedProgress.filesDone} / ${selectedProgress.filesTotal} файлов`
                                    : ''}
                              </span>
                              {selectedProgress.cancellable && (
                                <button
                                  type="button"
                                  onClick={() => void window.abi.cancelOperation(selected.key)}
                                  className="px-3 py-1 text-xs font-medium rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                >
                                  Отмена
                                </button>
                              )}
                            </div>
                          </>
                        )
                      })()}
                    </div>
                  )}

                  {/* Contextual Pack Sub-Tabs */}
                  <div className="px-6 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-[#0b111c]/80 flex items-center justify-between gap-4">
                    <nav className="flex items-center gap-6" aria-label="Разделы сборки">
                      {(
                        [
                          ['overview', 'Обзор', Package],
                          ['news', `Новости (${packNews.length})`, Newspaper],
                          [
                            'settings',
                            hasAnyOverride ? 'Параметры · изм.' : 'Параметры',
                            SlidersHorizontal
                          ],
                          [
                            'files',
                            selected.conflicts.length > 0
                              ? `Файлы и моды · конфликт (${selected.conflicts.length})`
                              : 'Файлы и моды',
                            HardDrive
                          ]
                        ] as Array<[PackSubTab, string, typeof Package]>
                      ).map(([tabId, label, Icon]) => {
                        const active = packTab === tabId
                        return (
                          <button
                            key={tabId}
                            type="button"
                            onClick={() => setPackTab(tabId)}
                            className={`relative py-3 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                              active
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                            }`}
                          >
                            <Icon className="w-3.5 h-3.5" />
                            <span>{label}</span>
                            {active && (
                              <motion.span
                                layoutId="pack-subtab-indicator"
                                transition={{ type: 'spring', stiffness: 520, damping: 38 }}
                                className="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-600 dark:bg-emerald-400 rounded-full"
                              />
                            )}
                          </button>
                        )
                      })}
                    </nav>

                    <div className="hidden xl:flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-tabular whitespace-nowrap shrink-0">
                      <span>ОЗУ: {formatMemoryGb(effectiveMemoryMb)}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {selected.installedVersion
                          ? `Установлена ${selected.installedVersion}`
                          : 'Не установлена'}
                      </span>
                    </div>
                  </div>

                  {/* Contextual Tab Body */}
                  <div className="p-6 max-w-4xl space-y-5">
                    {/* Offline / Cache Notice */}
                    {catalog?.fromCache && (
                      <div className="p-3.5 rounded-xl border border-amber-500/35 bg-amber-500/[0.08] flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-medium">
                          <WifiOff className="w-4 h-4 shrink-0" />
                          <span>
                            GitHub недоступен — показан кэш. Установленные сборки можно запускать
                            автономно.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void reloadCatalog()}
                          className="px-2.5 py-1 text-xs font-medium rounded-lg border border-amber-500/40 text-amber-800 dark:text-amber-300 hover:bg-amber-500/15"
                        >
                          Повторить
                        </button>
                      </div>
                    )}

                    {/* Error banners */}
                    {actionError && (
                      <ErrorBanner
                        error={actionError}
                        onRetry={() => void handlePrimaryAction(selected)}
                      />
                    )}
                    {selected.lastError && !actionError && (
                      <ErrorBanner
                        error={selected.lastError}
                        onRetry={() => void handlePrimaryAction(selected)}
                      />
                    )}

                    {/* Conflict Banner */}
                    {selected.conflicts.length > 0 && (
                      <div className="p-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <div className="space-y-0.5">
                            <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                              Найдены локальные изменения в файлах сборки ({selected.conflicts.length})
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-400">
                              Перед заменой лаунчер автоматически сохранит копию в{' '}
                              <span className="font-mono-tabular">.abilauncher/backups</span>.
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setConflictModal({
                              packKey: selected.key,
                              mode: selected.installedVersion ? 'play' : 'install'
                            })
                          }
                          className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 transition-colors whitespace-nowrap shrink-0"
                        >
                          Разобрать конфликты
                        </button>
                      </div>
                    )}

                    {/* Crash Banner */}
                    {lastCrashByPack[selected.key] && (
                      <div className="p-4 rounded-xl border border-rose-500/40 bg-rose-500/[0.08] flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <Bug className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                          <div className="space-y-0.5">
                            <div className="text-xs font-bold text-rose-800 dark:text-rose-300">
                              Последний запуск завершился с ошибкой (код{' '}
                              {lastCrashByPack[selected.key].exitCode ?? '?'})
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-300">
                              Откройте консоль, чтобы посмотреть краш-репорт и журнал Minecraft.
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConsoleOpen(true)}
                          className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-300 hover:bg-rose-500/15 transition-colors whitespace-nowrap shrink-0"
                        >
                          Открыть отчёт
                        </button>
                      </div>
                    )}

                    {/* Warnings */}
                    {selected.warnings.length > 0 && (
                      <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] space-y-1 text-xs">
                        {selected.warnings.map((w, i) => (
                          <div key={i} className="text-amber-800 dark:text-amber-300">
                            {w}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Animated Tab Body */}
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={`${selected.key}:${packTab}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {/* TAB: OVERVIEW */}
                        {packTab === 'overview' && (
                          <div className="space-y-6">
                            {selectedPreflight && (
                              <PreflightCard
                                packName={selected.name}
                                minecraftVersion={selected.minecraft}
                                activeProfileName={activeProfile?.name ?? null}
                                preflight={selectedPreflight}
                                onFixJava={() => void applyPreflightFix(selected.key, 'java')}
                                onFixMemory={() => void applyPreflightFix(selected.key, 'memory')}
                                onFixAll={() => void applyPreflightFix(selected.key, 'all')}
                                onSelectProfile={() => setAuthModalOpen(true)}
                              />
                            )}

                            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                              {/* About + Folders */}
                              <div className="lg:col-span-3 space-y-5">
                                <section className="space-y-2">
                                  <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                                    О сборке
                                  </h2>
                                  <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                                    {selected.description || selected.summary || 'Описание не указано.'}
                                  </p>
                                  <div className="pt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono-tabular">
                                    <span>
                                      Рекомендуется {formatMemoryGb(selected.recommendedMemoryMb)} ОЗУ
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span>
                                      {selected.source.official ? 'Официальный каталог' : 'Свой репозиторий'}
                                    </span>
                                  </div>
                                </section>

                                <section className="space-y-2.5">
                                  <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                    Быстрый доступ к папкам экземпляра
                                  </h3>
                                  <div className="flex flex-wrap items-center gap-2">
                                    {(
                                      [
                                        ['Корень', 'root', FolderOpen],
                                        ['mods', 'mods', Package],
                                        ['saves', 'saves', HardDrive],
                                        ['screenshots', 'screenshots', Camera],
                                        ['logs', 'logs', Terminal]
                                      ] as Array<[string, PackSubfolder, typeof FolderOpen]>
                                    ).map(([label, sub, Icon]) => (
                                      <button
                                        key={label}
                                        type="button"
                                        onClick={() => handleOpenFolder(selected.key, sub)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] text-slate-700 dark:text-slate-300 hover:border-emerald-500/50 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
                                      >
                                        <Icon className="w-3.5 h-3.5" />
                                        <span>{label}</span>
                                      </button>
                                    ))}
                                  </div>
                                </section>
                              </div>

                              {/* Linked Server */}
                              <div className="lg:col-span-2">
                                <section className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] space-y-3.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5">
                                      <Server className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                                      <span>Сервер сборки</span>
                                    </h2>
                                    {selected.server && isAllowed20tpsHost(selected.server.host) &&
                                      (() => {
                                        const sKey = serverKey(
                                          selected.server.host,
                                          selected.server.port
                                        )
                                        const st = serverStatuses[sKey]
                                        if (!st) {
                                          return (
                                            <span className="text-xs text-slate-400">Проверка…</span>
                                          )
                                        }
                                        return st.online ? (
                                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 font-mono-tabular">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                            {st.playersOnline ?? '?'}/{st.playersMax ?? '?'}
                                            {st.latencyMs !== null ? ` · ${st.latencyMs} мс` : ''}
                                          </span>
                                        ) : (
                                          <span className="text-xs text-rose-500">Офлайн</span>
                                        )
                                      })()}
                                  </div>

                                  {selected.server && isAllowed20tpsHost(selected.server.host) ? (
                                    (() => {
                                      const srv = selected.server
                                      const addr = formatServerAddress(srv.host, srv.port)
                                      const sKey = serverKey(srv.host, srv.port)
                                      const isPinging = Boolean(pingingServers[sKey])

                                      return (
                                        <div className="space-y-3">
                                          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                                            {srv.name}
                                          </div>
                                          <div className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-slate-50 dark:bg-slate-900/70 border border-slate-200/70 dark:border-slate-800">
                                            <span className="font-mono-tabular text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                                              {addr}
                                            </span>
                                            <div className="flex items-center gap-1 shrink-0">
                                              <button
                                                type="button"
                                                onClick={() => handleCopyAddress(addr)}
                                                title="Скопировать адрес"
                                                className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
                                              >
                                                {copiedAddr === addr ? (
                                                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                                                ) : (
                                                  <Copy className="w-3.5 h-3.5" />
                                                )}
                                              </button>
                                              <button
                                                type="button"
                                                disabled={isPinging}
                                                onClick={() => void pingOneServer(srv.host, srv.port)}
                                                title="Обновить пинг"
                                                className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
                                              >
                                                <RefreshCw
                                                  className={`w-3.5 h-3.5 ${isPinging ? 'animate-spin' : ''}`}
                                                />
                                              </button>
                                            </div>
                                          </div>

                                          {settings && (
                                            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                                              <input
                                                type="checkbox"
                                                checked={settings.autoJoinServer}
                                                onChange={(e) =>
                                                  void updateSettings({
                                                    autoJoinServer: e.target.checked
                                                  })
                                                }
                                                className="accent-emerald-600 dark:accent-emerald-500"
                                              />
                                              <span>Автоподключение при запуске игры</span>
                                            </label>
                                          )}
                                        </div>
                                      )
                                    })()
                                  ) : (
                                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                      Для этой сборки официальный сервер не указан — она рассчитана
                                      на одиночную игру или локальную сеть.
                                    </p>
                                  )}
                                </section>
                              </div>
                            </div>

                            {/* Latest Pack News */}
                            <section className="space-y-3 pt-1">
                              <div className="flex items-baseline justify-between">
                                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                                  Последние новости сборки
                                </h2>
                                {packNews.length > 2 && (
                                  <button
                                    type="button"
                                    onClick={() => setPackTab('news')}
                                    className="text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                                  >
                                    Все записи ({packNews.length})
                                  </button>
                                )}
                              </div>

                              {packNews.length === 0 ? (
                                <div className="text-xs text-slate-500 dark:text-slate-400">
                                  Для этой сборки пока нет опубликованных новостей.
                                </div>
                              ) : (
                                <div className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-b border-slate-200 dark:border-slate-800">
                                  {packNews.slice(0, 2).map((item) => {
                                    const isLong = item.body.length > 220 || item.body.split('\n').length > 6
                                    return (
                                      <article key={item.id} className="py-3.5 space-y-1.5">
                                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                                          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                            {item.title}
                                          </h3>
                                          <span className="text-xs font-mono-tabular text-slate-500 dark:text-slate-400">
                                            {formatDateRu(item.date)}
                                            {item.packVersion ? ` · ${item.packVersion}` : ''}
                                          </span>
                                        </div>
                                        <MarkdownContent content={item.body} compact />
                                        {isLong && (
                                          <button
                                            type="button"
                                            onClick={() => setPackTab('news')}
                                            className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 hover:underline pt-0.5"
                                          >
                                            Читать полностью →
                                          </button>
                                        )}
                                      </article>
                                    )
                                  })}
                                </div>
                              )}
                            </section>
                          </div>
                        )}

                        {/* TAB: NEWS */}
                        {packTab === 'news' && (
                          <div className="space-y-4">
                            <div className="flex items-center justify-between gap-2">
                              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                                Журнал обновлений — {selected.name}
                              </h2>
                              <button
                                type="button"
                                disabled={loadingNews}
                                onClick={() => void reloadNews()}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                              >
                                <RefreshCw
                                  className={`w-3.5 h-3.5 ${loadingNews ? 'animate-spin' : ''}`}
                                />
                                <span>Обновить</span>
                              </button>
                            </div>

                            {packNews.length === 0 ? (
                              <div className="py-10 text-center text-xs text-slate-500">
                                Новостей пока нет.
                              </div>
                            ) : (
                              <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#0e1521]">
                                {packNews.map((item) => (
                                  <article key={item.id} className="p-5 space-y-2">
                                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                                      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                                        {item.title}
                                      </h3>
                                      <span className="text-xs font-mono-tabular text-slate-500 dark:text-slate-400">
                                        {formatDateRu(item.date)}
                                        {item.packVersion ? ` · ${item.packVersion}` : ''}
                                      </span>
                                    </div>
                                    <MarkdownContent content={item.body} />
                                  </article>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* TAB: PACK SETTINGS */}
                        {packTab === 'settings' && settings && (
                          <div className="space-y-6">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                                  Индивидуальные параметры запуска
                                </h2>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                  Переопределяют глобальные настройки только для «{selected.name}».
                                </p>
                              </div>
                              {hasAnyOverride && (
                                <button
                                  type="button"
                                  onClick={() => void resetPackOverrides(selected.key)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  <span>Сбросить к общим</span>
                                </button>
                              )}
                            </div>

                            <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521] space-y-6">
                              {/* RAM Override */}
                              <div className="space-y-2.5">
                                <div className="flex flex-wrap items-baseline justify-between gap-2">
                                  <label className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                    Оперативная память (ОЗУ)
                                  </label>
                                  <div className="flex items-center gap-2 text-xs font-mono-tabular">
                                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                                      {effectiveMemoryMb} МБ ({formatMemoryGb(effectiveMemoryMb)})
                                    </span>
                                    <span className="text-slate-400">
                                      {selectedOverride?.memoryMb ? '· своё значение' : '· по умолчанию'}
                                    </span>
                                  </div>
                                </div>
                                <input
                                  type="range"
                                  min={2048}
                                  max={sliderMaxMb}
                                  step={512}
                                  value={Math.min(effectiveMemoryMb, sliderMaxMb)}
                                  onChange={(e) =>
                                    void updatePackOverride(selected.key, {
                                      memoryMb: Number(e.target.value)
                                    })
                                  }
                                  className="w-full accent-emerald-600 dark:accent-emerald-500"
                                />
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                  <span className="text-slate-500 dark:text-slate-400">
                                    Рекомендация сборки:{' '}
                                    <span className="font-mono-tabular font-medium text-slate-800 dark:text-slate-200">
                                      {selected.recommendedMemoryMb} МБ
                                    </span>
                                  </span>
                                  <Tooltip
                                    content={`Для стабильного FPS в «${selected.name}» оптимально ${formatMemoryGb(selectedPreflight?.recommendedMemoryMb ?? selected.recommendedMemoryMb)} из ${formatMemoryGb(systemMemMb)} ОЗУ вашего ПК — с запасом для операционной системы.`}
                                    placement="top"
                                    align="right"
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void updatePackOverride(selected.key, {
                                          memoryMb:
                                            selectedPreflight?.recommendedMemoryMb ??
                                            selected.recommendedMemoryMb
                                        })
                                      }
                                      className="text-emerald-700 dark:text-emerald-400 font-medium hover:underline"
                                    >
                                      Поставить рекомендуемые{' '}
                                      {formatMemoryGb(
                                        selectedPreflight?.recommendedMemoryMb ??
                                          selected.recommendedMemoryMb
                                      )}
                                    </button>
                                  </Tooltip>
                                </div>
                                <MemoryAllocationBar
                                  activeMemoryMb={effectiveMemoryMb}
                                  recommendedMemoryMb={
                                    selectedPreflight?.recommendedMemoryMb ??
                                    selected.recommendedMemoryMb
                                  }
                                  systemMemoryMb={systemMemMb}
                                />
                              </div>

                              <hr className="border-slate-200 dark:border-slate-800" />

                              {/* Java Override */}
                              <div className="space-y-2">
                                <label className="block text-xs font-semibold text-slate-900 dark:text-slate-100">
                                  Среда выполнения Java
                                </label>
                                <select
                                  value={selectedOverride?.javaPath ?? ''}
                                  onChange={(e) =>
                                    void updatePackOverride(selected.key, {
                                      javaPath: e.target.value || null
                                    })
                                  }
                                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                >
                                  <option value="">
                                    Авто / из общих настроек (рекомендуемая Java{' '}
                                    {requiredJavaMajorForMinecraft(selected.minecraft)})
                                  </option>
                                  {javaList.map((j) => (
                                    <option key={j.path} value={j.path}>
                                      Java {j.majorVersion} ({j.version}) ·{' '}
                                      {j.managed ? 'AbiLauncher' : 'Системная'}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <hr className="border-slate-200 dark:border-slate-800" />

                              {/* JVM Args */}
                              <div className="space-y-2">
                                <label className="block text-xs font-semibold text-slate-900 dark:text-slate-100">
                                  Дополнительные JVM-аргументы для этой сборки
                                </label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={packJvmInput}
                                    onChange={(e) => setPackJvmInput(e.target.value)}
                                    placeholder={
                                      settings.extraJvmArgs
                                        ? `По умолчанию: ${settings.extraJvmArgs}`
                                        : 'Например: -Dfile.encoding=UTF-8 -Dfml.readTimeout=120'
                                    }
                                    className="flex-1 px-3 py-2 text-xs font-mono-tabular rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void updatePackOverride(selected.key, {
                                        extraJvmArgs: packJvmInput.trim() || null
                                      })
                                      pushToast('JVM-аргументы сборки сохранены', 'ok')
                                    }}
                                    className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap shrink-0"
                                  >
                                    Сохранить
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* TAB: FILES, MODS, SHADERS & INTEGRITY */}
                        {packTab === 'files' && (
                          <PackContentManager
                            pack={selected}
                            isBusy={selectedIsBusy}
                            onCheckPack={() => handleCheckPack(selected.key)}
                            onOpenFolder={(sub) => handleOpenFolder(selected.key, sub)}
                            onToast={pushToast}
                          />
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>

                {/* Sticky Bottom Launch Bar */}
                <footer className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0b111c]/95 flex flex-wrap items-center justify-between gap-4 shrink-0">
                  <div className="min-w-0 flex items-center gap-2.5 text-xs">
                    <span className={`font-semibold ${statusToneClass(selected.status)}`}>
                      {STATUS_LABELS[selected.status].label}
                    </span>
                    <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono-tabular text-slate-500 dark:text-slate-400 truncate">
                      {selected.installedVersion
                        ? selected.installedVersion === selected.version
                          ? `v${selected.installedVersion}`
                          : `v${selected.installedVersion} → v${selected.version}`
                        : `v${selected.version}`}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {selectedPreflight &&
                      (!selectedPreflight.javaOk || !selectedPreflight.memoryOk) &&
                      !selectedIsBusy && (
                        <Tooltip
                          placement="top"
                          align="right"
                          content={
                            !selectedPreflight.javaOk && !selectedPreflight.memoryOk
                              ? `Для MC ${selected.minecraft} выберется ${selectedPreflight.recommendedJavaLabel ?? `Java ${selectedPreflight.requiredJavaMajor}`}, а память увеличится до ${formatMemoryGb(selectedPreflight.recommendedMemoryMb)} из ${formatMemoryGb(selectedPreflight.systemMemoryMb)} ОЗУ вашего ПК.`
                              : !selectedPreflight.javaOk
                                ? `Minecraft ${selected.minecraft} требует Java ${selectedPreflight.requiredJavaMajor}. Параметр применится только к «${selected.name}».`
                                : `Для «${selected.name}» оптимально ${formatMemoryGb(selectedPreflight.recommendedMemoryMb)} из ${formatMemoryGb(selectedPreflight.systemMemoryMb)} ОЗУ вашего ПК — с запасом для системы.`
                          }
                        >
                          <button
                            type="button"
                            onClick={() =>
                              void applyPreflightFix(
                                selected.key,
                                !selectedPreflight.javaOk && !selectedPreflight.memoryOk
                                  ? 'all'
                                  : !selectedPreflight.javaOk
                                    ? 'java'
                                    : 'memory'
                              )
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg border border-amber-500/45 bg-amber-500/10 text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Wrench className="w-3.5 h-3.5" />
                            <span>
                              {!selectedPreflight.javaOk && !selectedPreflight.memoryOk
                                ? 'Поправить Java и ОЗУ'
                                : !selectedPreflight.javaOk
                                  ? `Нужна Java ${selectedPreflight.requiredJavaMajor} · Исправить`
                                  : `Мало ОЗУ · ${formatMemoryGb(selectedPreflight.recommendedMemoryMb)}`}
                            </span>
                          </button>
                        </Tooltip>
                      )}

                    <button
                      type="button"
                      disabled={selectedIsBusy}
                      onClick={() => void handleCheckPack(selected.key)}
                      title="Проверить целостность файлов сборки"
                      className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Проверить</span>
                    </button>

                    <button
                      type="button"
                      disabled={
                        selected.status === 'checking' ||
                        selected.status === 'downloading' ||
                        selected.status === 'launching'
                      }
                      onClick={() => void handlePrimaryAction(selected)}
                      className={`inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        selected.status === 'conflict'
                          ? 'bg-amber-500 hover:bg-amber-600 text-slate-950'
                          : selected.status === 'running'
                            ? 'bg-emerald-600/15 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                            : 'bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] shadow-sm'
                      } disabled:opacity-60`}
                    >
                      {selected.status === 'checking' ||
                      selected.status === 'downloading' ||
                      selected.status === 'launching' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : selected.status === 'not-installed' ||
                        selected.status === 'update-available' ? (
                        <Download className="w-4 h-4" />
                      ) : selected.status === 'conflict' ? (
                        <AlertTriangle className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4 fill-current" />
                      )}
                      <span>{primaryLabel(selected)}</span>
                    </button>
                  </div>
                </footer>
              </>
            )}
          </main>

          {/* Slide-out Drawers */}
          <DownloadsDrawer
            open={downloadsOpen}
            onClose={() => setDownloadsOpen(false)}
            packs={packs}
            progressByPack={progressByPack}
            completedTasks={completedTasks}
            onCancelOp={(packKey) => void window.abi.cancelOperation(packKey)}
            onTriggerUpdate={(packKey) => {
              const target = packs.find((p) => p.key === packKey)
              if (!target) return
              if (target.conflicts.length > 0) {
                setDownloadsOpen(false)
                setConflictModal({ packKey, mode: target.installedVersion ? 'play' : 'install' })
              } else {
                void handleInstallPack(packKey)
              }
            }}
            onSelectPack={(packKey) => {
              setSelectedPackKey(packKey)
              setMainView('pack')
            }}
          />

          <ConsoleDrawer
            open={consoleOpen}
            onClose={() => setConsoleOpen(false)}
            packs={packs}
            logs={logs}
            crashes={crashes}
            onClearLogs={() => setLogs([])}
            onClearCrash={(packKey) =>
              setLastCrashByPack((prev) => {
                const next = { ...prev }
                delete next[packKey]
                return next
              })
            }
            onOpenFolder={(packKey, sub) => handleOpenFolder(packKey, sub)}
            onCopyNotice={() => pushToast('Логи скопированы в буфер обмена', 'info')}
          />
        </div>

        {/* Shared Modals */}
        {addRepoOpen && (
          <AddRepoModal onClose={() => setAddRepoOpen(false)} onAdd={handleAddRepo} />
        )}

        {conflictModal && conflictPack && (
          <ConflictModal
            packName={conflictPack.name}
            conflicts={conflictPack.conflicts}
            actionLabel={
              conflictModal.mode === 'play' ? 'Применить и запустить' : 'Применить и установить'
            }
            onCancel={() => setConflictModal(null)}
            onApply={(resolutions) => {
              const { packKey, mode } = conflictModal
              setConflictModal(null)
              if (mode === 'play') {
                void handlePlayPack(packKey, { resolutions })
              } else {
                void handleInstallPack(packKey, resolutions)
              }
            }}
          />
        )}

        <AuthLoginModal
          open={authModalOpen}
          siteUrl={authConfig.siteUrl}
          onClose={() => setAuthModalOpen(false)}
          onSuccess={(session) => {
            setAuthSession(session)
            pushToast(`Добро пожаловать, ${session.username}!`, 'ok')
          }}
          onOpenSitePage={(pagePath) => {
            void window.abi.authOpenSitePage(pagePath)
          }}
        />

        {/* Toast Stack */}
        <div
          aria-live="polite"
          className="fixed bottom-16 right-5 z-50 flex flex-col gap-2 pointer-events-none"
        >
          <AnimatePresence>
            {toasts.map((toast) => (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.96 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                className={`pointer-events-auto px-3.5 py-2.5 rounded-lg border shadow-xl text-xs font-medium max-w-xs ${
                  toast.tone === 'ok'
                    ? 'bg-emerald-950/95 border-emerald-500/40 text-emerald-100'
                    : toast.tone === 'warn'
                      ? 'bg-amber-950/95 border-amber-500/40 text-amber-100'
                      : 'bg-slate-900/95 border-slate-700 text-slate-100'
                }`}
              >
                {toast.message}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  )
}
