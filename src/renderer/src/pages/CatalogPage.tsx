import { useEffect, useState } from 'react'
import type {
  CatalogResult,
  ConflictChoice,
  JavaInfoView,
  PackStatus,
  PackSubfolder,
  PackView,
  ProfilesState,
  ProgressEvent,
  ServerStatus,
  Settings,
  UserError
} from '@shared/types'
import { ConflictModal } from '../components/ConflictModal'
import { ErrorBanner } from '../components/ErrorBanner'
import type { PackCrashInfo } from './ConsolePage'
import {
  IconAlert,
  IconCamera,
  IconCancel,
  IconCheck,
  IconCopy,
  IconCpu,
  IconDownloads,
  IconFolder,
  IconPackage,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconServers,
  IconShield,
  IconTerminal,
  IconWifiOff,
  StatusIcon
} from '../components/Icons'
import {
  STAGE_LABELS,
  STATUS_LABELS,
  formatBytes,
  formatLoader,
  formatServerAddress,
  formatSpeed
} from '../utils/format'

interface CatalogPageProps {
  catalog: CatalogResult | null
  loadingCatalog: boolean
  selectedPackKey: string | null
  onSelectPack: (key: string) => void
  settings: Settings | null
  totalMemoryMb: number
  profiles: ProfilesState
  javaList: JavaInfoView[]
  progressByPack: Record<string, ProgressEvent>
  serverStatuses: Record<string, ServerStatus>
  lastCrashByPack: Record<string, PackCrashInfo>
  latestMinecraftLogLine: string | null
  onReloadCatalog: () => void
  onAddRepo: (repo: string, branch?: string) => Promise<void>
  onCheckPack: (key: string) => Promise<void>
  onInstallPack: (key: string, resolutions?: Record<string, ConflictChoice>) => Promise<boolean>
  onPlayPack: (
    key: string,
    opts?: { resolutions?: Record<string, ConflictChoice>; joinServer?: boolean }
  ) => Promise<boolean>
  onCancelOp: (key: string) => void
  onOpenFolder: (key: string, subfolder?: PackSubfolder) => void
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void>
  onPingServer: (host: string, port?: number) => void
  onGoProfiles: () => void
  onOpenConsole: () => void
}

function DefaultCoverSvg({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? 'A').toUpperCase()
  return (
    <svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id="abiCoverGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#124e41" />
          <stop offset="100%" stopColor="#0f2942" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" fill="url(#abiCoverGrad)" />
      <text
        x="60"
        y="74"
        textAnchor="middle"
        fill="#a7f3d0"
        fontSize="52"
        fontWeight="700"
        fontFamily="Segoe UI, sans-serif"
      >
        {initial}
      </text>
    </svg>
  )
}

function serverKey(host: string, port?: number): string {
  return `${host}:${port ?? 25565}`
}

export function CatalogPage(props: CatalogPageProps) {
  const [showAddRepo, setShowAddRepo] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [branchInput, setBranchInput] = useState('')
  const [repoBusy, setRepoBusy] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
  const [conflictMode, setConflictMode] = useState<'install' | 'play' | null>(null)
  const [actionError, setActionError] = useState<UserError | null>(null)
  const [packJvmInput, setPackJvmInput] = useState('')

  const packs = props.catalog?.packs ?? []
  const selected: PackView | null =
    packs.find((p) => p.key === props.selectedPackKey) ?? packs[0] ?? null
  const packOverride = selected && props.settings ? props.settings.packOverrides[selected.key] : undefined

  useEffect(() => {
    setPackJvmInput(packOverride?.extraJvmArgs ?? '')
  }, [selected?.key, packOverride?.extraJvmArgs])

  const activeProgress = selected ? props.progressByPack[selected.key] : undefined
  const isBusy =
    selected !== null &&
    (selected.status === 'checking' ||
      selected.status === 'downloading' ||
      selected.status === 'launching' ||
      selected.status === 'running')

  const hasProfile = props.profiles.profiles.some((p) => p.id === props.profiles.selectedId)

  const handleAddRepoSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!repoInput.trim()) return
    setRepoBusy(true)
    setRepoError(null)
    try {
      await props.onAddRepo(repoInput.trim(), branchInput.trim() || undefined)
      setRepoInput('')
      setBranchInput('')
      setShowAddRepo(false)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
    } finally {
      setRepoBusy(false)
    }
  }

  const handlePrimaryAction = async (pack: PackView) => {
    setActionError(null)
    if (pack.status === 'conflict') {
      setConflictMode(pack.installedVersion ? 'play' : 'install')
      return
    }
    if (!pack.installedVersion) {
      const ok = await props.onInstallPack(pack.key)
      if (!ok && pack.conflicts.length > 0) setConflictMode('install')
      return
    }
    if (!hasProfile) {
      setActionError({
        code: 'no-profile',
        title: 'Не выбран локальный профиль',
        message: 'Перед запуском игры выберите или создайте локальный профиль.',
        hint: 'Откройте вкладку «Профили» и введите никнейм.'
      })
      return
    }
    const ok = await props.onPlayPack(pack.key)
    if (!ok && pack.conflicts.length > 0) setConflictMode('play')
  }

  const primaryButtonLabel = (pack: PackView): string => {
    switch (pack.status) {
      case 'not-installed':
        return 'Установить'
      case 'checking':
        return 'Проверяется…'
      case 'downloading':
        return 'Загружается…'
      case 'update-available':
        return 'Обновить и играть'
      case 'ready':
        return 'Проверить и играть'
      case 'conflict':
        return 'Решить конфликты и играть'
      case 'error':
        return 'Повторить'
      case 'launching':
        return 'Запуск игры…'
      case 'running':
        return 'Игра запущена'
    }
  }

  const primaryActionIcon = (status: PackStatus) => {
    switch (status) {
      case 'not-installed':
      case 'update-available':
        return <IconDownloads size={17} />
      case 'checking':
      case 'downloading':
      case 'launching':
        return <IconRefresh size={17} className="spin-slow" />
      case 'conflict':
        return <IconAlert size={17} />
      case 'error':
        return <IconRefresh size={17} />
      case 'ready':
      case 'running':
        return <IconPlay size={17} />
    }
  }

  const handleCopyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr).catch(() => undefined)
    setCopiedAddr(addr)
    setTimeout(() => setCopiedAddr((cur) => (cur === addr ? null : cur)), 1800)
  }

  const setPackMemoryOverride = (memoryMb: number | null) => {
    if (!selected || !props.settings) return
    void props.onUpdateSettings({
      packOverrides: {
        ...props.settings.packOverrides,
        [selected.key]: { ...packOverride, memoryMb }
      }
    })
  }

  const setPackJavaOverride = (javaPath: string | null) => {
    if (!selected || !props.settings) return
    void props.onUpdateSettings({
      packOverrides: {
        ...props.settings.packOverrides,
        [selected.key]: { ...packOverride, javaPath }
      }
    })
  }

  const setPackJvmOverride = (extraJvmArgs: string | null) => {
    if (!selected || !props.settings) return
    void props.onUpdateSettings({
      packOverrides: {
        ...props.settings.packOverrides,
        [selected.key]: { ...packOverride, extraJvmArgs }
      }
    })
  }

  return (
    <div className="stack">
      <div className="row-between">
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={props.loadingCatalog}
            onClick={props.onReloadCatalog}
          >
            <IconRefresh size={15} className={props.loadingCatalog ? 'spin-slow' : ''} />
            <span>{props.loadingCatalog ? 'Обновление каталога…' : 'Обновить каталог'}</span>
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setShowAddRepo((v) => !v)}
          >
            <IconPlus size={15} />
            <span>Добавить сборку по ссылке</span>
          </button>
        </div>
        {props.catalog?.loadedAt && (
          <span className="subtle">
            Обновлено: {new Date(props.catalog.loadedAt).toLocaleTimeString('ru-RU')}
          </span>
        )}
      </div>

      {showAddRepo && (
        <form onSubmit={handleAddRepoSubmit} className="card-flat stack-sm">
          <div style={{ fontWeight: 600 }}>Добавить репозиторий сборки GitHub</div>
          <div className="grid-2">
            <input
              className="input"
              placeholder="owner/repo или https://github.com/owner/repo"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
            />
            <input
              className="input"
              placeholder="Ветка (по умолчанию main)"
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
            />
          </div>
          {repoError && <div className="subtle" style={{ color: 'var(--danger)' }}>{repoError}</div>}
          <div className="row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={repoBusy}>
              <IconCheck size={13} />
              <span>{repoBusy ? 'Добавление…' : 'Добавить'}</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setShowAddRepo(false)}>
              <IconCancel size={13} />
              <span>Отмена</span>
            </button>
          </div>
        </form>
      )}

      {props.catalog?.fromCache && (
        <div className="banner banner-warn">
          <div className="row-between">
            <div className="row" style={{ gap: 8 }}>
              <IconWifiOff size={16} />
              <strong>GitHub недоступен — показаны сохранённые сборки</strong>
            </div>
            <button type="button" className="btn btn-sm" onClick={props.onReloadCatalog}>
              <IconRefresh size={13} />
              <span>Повторить проверку</span>
            </button>
          </div>
          <div>
            {props.catalog.catalogError ??
              'Уже установленные сборки можно запускать без интернета (автономный режим). Для установки новых сборок и проверки обновлений требуется связь с GitHub.'}
          </div>
        </div>
      )}

      {!props.catalog?.fromCache && props.catalog?.catalogError && (
        <div className="banner banner-warn">
          <div className="row-between">
            <div className="row" style={{ gap: 8 }}>
              <IconAlert size={16} />
              <strong>Не удалось загрузить общий каталог GitHub</strong>
            </div>
            <button type="button" className="btn btn-sm" onClick={props.onReloadCatalog}>
              <IconRefresh size={13} />
              <span>Повторить</span>
            </button>
          </div>
          <div>{props.catalog.catalogError}</div>
          <div className="subtle">
            Дополнительные репозитории сборок продолжают загружаться.
          </div>
        </div>
      )}

      {props.catalog && props.catalog.errors.length > 0 && (
        <div className="banner banner-warn">
          <div className="row" style={{ gap: 8 }}>
            <IconAlert size={16} />
            <strong>Часть репозиториев не ответила:</strong>
          </div>
          {props.catalog.errors.map((err) => (
            <div key={err.repo} className="subtle">
              <span className="mono">{err.repo}</span>: {err.message}
            </div>
          ))}
        </div>
      )}

      {packs.length === 0 ? (
        <div className="card stack" style={{ alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}>Каталог сборок пуст</h3>
          <p className="muted" style={{ margin: 0 }}>
            {props.loadingCatalog
              ? 'Загружаем список сборок из GitHub…'
              : 'Проверьте подключение к интернету, адрес официального каталога в настройках или добавьте репозиторий сборки вручную.'}
          </p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={props.onReloadCatalog}>
              <IconRefresh size={15} />
              <span>Повторить проверку</span>
            </button>
            <button type="button" className="btn" onClick={() => setShowAddRepo(true)}>
              <IconPlus size={15} />
              <span>Добавить репозиторий</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="catalog-layout">
          <div className="pack-list">
            {packs.map((pack) => {
              const badge = STATUS_LABELS[pack.status]
              const isSelected = selected?.key === pack.key
              return (
                <button
                  key={pack.key}
                  type="button"
                  className={`pack-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    setActionError(null)
                    props.onSelectPack(pack.key)
                  }}
                >
                  <div className="pack-thumb">
                    {pack.coverDataUrl ? (
                      <img src={pack.coverDataUrl} alt={pack.name} className="pack-thumb" />
                    ) : (
                      <DefaultCoverSvg name={pack.name} />
                    )}
                  </div>
                  <div className="stack-sm" style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {pack.name}
                    </div>
                    <div className="subtle">
                      MC {pack.minecraft} · {formatLoader(pack.loader)}
                    </div>
                    <div className="row-between">
                      <span className={`badge badge-${badge.tone}`}>
                        <StatusIcon status={pack.status} size={12} />
                        <span>{badge.label}</span>
                      </span>
                      <span className="subtle mono">{pack.version}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {selected && (
            <div className="card stack">
              <div className="pack-hero">
                {selected.coverDataUrl && (
                  <img src={selected.coverDataUrl} alt={selected.name} className="pack-hero-bg" />
                )}
                <div className="pack-hero-overlay" />
                <div className="pack-hero-content stack-sm">
                  <div className="row-between">
                    <span className="hero-chip">
                      {selected.source.official ? <IconShield size={12} /> : <IconPlus size={12} />}
                      <span>
                        {selected.source.official ? 'Официальная сборка' : 'Добавленный репозиторий'} ·{' '}
                        {selected.source.repo}
                      </span>
                    </span>
                    <span className={`badge badge-${STATUS_LABELS[selected.status].tone}`}>
                      <StatusIcon status={selected.status} size={13} />
                      <span>{STATUS_LABELS[selected.status].label}</span>
                    </span>
                  </div>
                  <h2 style={{ margin: 0, fontSize: 25, letterSpacing: '-0.02em' }}>{selected.name}</h2>
                  <div className="row">
                    <span className="hero-chip">Minecraft {selected.minecraft}</span>
                    <span className="hero-chip">{formatLoader(selected.loader)}</span>
                    <span className="hero-chip">Версия сборки: {selected.version}</span>
                    {selected.installedVersion && (
                      <span className="hero-chip">Установлено: {selected.installedVersion}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="row-between">
                <div className="row">
                  <button
                    type="button"
                    className={`btn btn-lg ${selected.status === 'error' ? 'btn-warn' : 'btn-primary'}`}
                    disabled={isBusy}
                    onClick={() => void handlePrimaryAction(selected)}
                  >
                    {primaryActionIcon(selected.status)}
                    <span>{primaryButtonLabel(selected)}</span>
                  </button>

                  {activeProgress?.cancellable && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => props.onCancelOp(selected.key)}
                    >
                      <IconCancel size={15} />
                      <span>Отменить</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn"
                    disabled={isBusy}
                    onClick={() => void props.onCheckPack(selected.key)}
                  >
                    <IconShield size={15} />
                    <span>Проверить файлы</span>
                  </button>
                </div>

                <button
                  type="button"
                  className="btn"
                  onClick={() => props.onOpenFolder(selected.key, 'root')}
                >
                  <IconFolder size={15} />
                  <span>Папка сборки</span>
                </button>
              </div>

              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onOpenFolder(selected.key, 'mods')}
                >
                  <IconPackage size={13} />
                  <span>mods/</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onOpenFolder(selected.key, 'screenshots')}
                >
                  <IconCamera size={13} />
                  <span>screenshots/</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onOpenFolder(selected.key, 'crash-reports')}
                >
                  <IconAlert size={13} />
                  <span>crash-reports/</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onOpenFolder(selected.key, 'logs')}
                >
                  <IconFolder size={13} />
                  <span>logs/</span>
                </button>
                <button type="button" className="btn btn-sm" onClick={props.onOpenConsole}>
                  <IconTerminal size={13} />
                  <span>Консоль игры</span>
                </button>
              </div>

              {(selected.status === 'running' || selected.status === 'launching') && (
                <div className="card-flat row-between">
                  <div className="row" style={{ minWidth: 0, flex: 1 }}>
                    <span className="status-dot dot-live" />
                    <span className="subtle mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {props.latestMinecraftLogLine ?? 'Minecraft запускается…'}
                    </span>
                  </div>
                  <button type="button" className="btn btn-sm btn-primary" onClick={props.onOpenConsole}>
                    <IconTerminal size={13} />
                    <span>Живая консоль</span>
                  </button>
                </div>
              )}

              {activeProgress && (
                <div className="card-flat stack-sm">
                  <div className="row-between">
                    <div className="row" style={{ gap: 8 }}>
                      <IconDownloads size={15} />
                      <strong>{STAGE_LABELS[activeProgress.stage]}</strong>
                    </div>
                    <span className="subtle">
                      {activeProgress.bytesTotal > 0
                        ? `${formatBytes(activeProgress.bytesDone)} / ${formatBytes(activeProgress.bytesTotal)} · ${formatSpeed(activeProgress.speed)}`
                        : activeProgress.label}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${activeProgress.bytesTotal <= 0 ? 'indeterminate' : ''}`}
                      style={
                        activeProgress.bytesTotal > 0
                          ? { width: `${Math.min(100, Math.round((activeProgress.bytesDone / activeProgress.bytesTotal) * 100))}%` }
                          : undefined
                      }
                    />
                  </div>
                  <div className="row-between subtle">
                    <span>{activeProgress.label}</span>
                    {activeProgress.filesTotal > 0 && (
                      <span>
                        Файлов: {activeProgress.filesDone} / {activeProgress.filesTotal}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {actionError && (
                <ErrorBanner
                  error={actionError}
                  onRetry={actionError.code === 'no-profile' ? props.onGoProfiles : () => void handlePrimaryAction(selected)}
                  retryLabel={actionError.code === 'no-profile' ? 'Открыть профили' : 'Повторить'}
                />
              )}

              {selected.lastError && !actionError && (
                <ErrorBanner
                  error={selected.lastError}
                  onRetry={() => void handlePrimaryAction(selected)}
                  retryLabel="Повторить"
                />
              )}

              {props.lastCrashByPack[selected.key] && (
                <div className="banner banner-warn">
                  <div className="row-between">
                    <div className="row" style={{ gap: 8 }}>
                      <IconAlert size={16} />
                      <strong>
                        Последний вылет игры (код {props.lastCrashByPack[selected.key].exitCode ?? '?'})
                      </strong>
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => props.onOpenFolder(selected.key, 'crash-reports')}
                      >
                        <IconFolder size={13} />
                        <span>Открыть crash-reports/</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={props.onOpenConsole}
                      >
                        <IconTerminal size={13} />
                        <span>Открыть краш-лог в консоли</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {selected.conflicts.length > 0 && (
                <div className="banner banner-warn">
                  <div className="row-between">
                    <div className="row" style={{ gap: 8 }}>
                      <IconAlert size={16} />
                      <strong>Обнаружены изменения в файлах сборки ({selected.conflicts.length})</strong>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => setConflictMode(selected.installedVersion ? 'play' : 'install')}
                    >
                      Выбрать действие
                    </button>
                  </div>
                  <div className="subtle">
                    Запуск заблокирован, пока не выбрано действие для конфликтных файлов.
                  </div>
                </div>
              )}

              {selected.warnings.length > 0 && (
                <div className="banner banner-warn">
                  <div className="row" style={{ gap: 8 }}>
                    <IconAlert size={16} />
                    <strong>Предупреждения</strong>
                  </div>
                  {selected.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}

              {selected.description && (
                <div className="stack-sm">
                  <h4 className="section-header">Описание</h4>
                  <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{selected.description}</p>
                </div>
              )}

              <div className="grid-2">
                <div className="card-flat stack-sm">
                  <h4 className="section-header">
                    <IconCpu size={16} />
                    <span>Параметры запуска этой сборки</span>
                  </h4>
                  <label className="stack-sm" style={{ gap: 4 }}>
                    <span className="subtle">
                      Память ОЗУ (рекомендовано {selected.recommendedMemoryMb} МБ)
                    </span>
                    <select
                      className="select"
                      value={packOverride?.memoryMb ?? ''}
                      onChange={(e) =>
                        setPackMemoryOverride(e.target.value ? Number(e.target.value) : null)
                      }
                    >
                      <option value="">
                        Авто (по умолчанию / {selected.recommendedMemoryMb} МБ)
                      </option>
                      {[2048, 3072, 4096, 6144, 8192, 10240, 12288, 16384]
                        .filter((m) => m <= props.totalMemoryMb)
                        .map((mb) => (
                          <option key={mb} value={mb}>
                            {mb} МБ ({(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} ГБ)
                          </option>
                        ))}
                    </select>
                  </label>

                  <label className="stack-sm" style={{ gap: 4 }}>
                    <span className="subtle">Java для этой сборки</span>
                    <select
                      className="select"
                      value={packOverride?.javaPath ?? ''}
                      onChange={(e) => setPackJavaOverride(e.target.value || null)}
                    >
                      <option value="">По умолчанию из настроек (рекомендуемая)</option>
                      {props.javaList.map((j) => (
                        <option key={j.path} value={j.path}>
                          Java {j.majorVersion} ({j.version}) {j.managed ? '[AbiLauncher]' : '[Системная]'}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="stack-sm" style={{ gap: 4 }}>
                    <span className="subtle">JVM-аргументы для этой сборки</span>
                    <div className="row">
                      <input
                        className="input mono"
                        style={{ flex: 1 }}
                        placeholder={
                          props.settings?.extraJvmArgs
                            ? `По умолчанию: ${props.settings.extraJvmArgs}`
                            : 'Как в общих настройках (опционально)'
                        }
                        value={packJvmInput}
                        onChange={(e) => setPackJvmInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => setPackJvmOverride(packJvmInput.trim() || null)}
                      >
                        <IconCheck size={13} />
                        <span>Сохранить</span>
                      </button>
                      {packOverride?.extraJvmArgs && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setPackJvmInput('')
                            setPackJvmOverride(null)
                          }}
                        >
                          Сброс
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card-flat stack-sm">
                  <h4 className="section-header">
                    <IconServers size={16} />
                    <span>Связанный сервер</span>
                  </h4>
                  {selected.server ? (
                    (() => {
                      const addr = formatServerAddress(selected.server.host, selected.server.port)
                      const st = props.serverStatuses[serverKey(selected.server.host, selected.server.port)]
                      return (
                        <div className="stack-sm">
                          <div className="row-between">
                            <span style={{ fontWeight: 600 }}>{selected.server.name}</span>
                            {st ? (
                              <span className={`badge ${st.online ? 'badge-ok' : 'badge-danger'}`}>
                                <span className={`status-dot ${st.online ? 'dot-live' : 'dot-down'}`} />
                                <span>
                                  {st.online
                                    ? `Онлайн · ${st.playersOnline ?? '?'}/${st.playersMax ?? '?'}`
                                    : 'Офлайн'}
                                </span>
                              </span>
                            ) : (
                              <span className="badge badge-neutral">
                                <span className="status-dot dot-idle" />
                                <span>Не проверен</span>
                              </span>
                            )}
                          </div>
                          <div className="row-between">
                            <span className="mono">{addr}</span>
                            <div className="row">
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => handleCopyAddress(addr)}
                              >
                                {copiedAddr === addr ? <IconCheck size={13} /> : <IconCopy size={13} />}
                                <span>{copiedAddr === addr ? 'Скопировано' : 'Копировать'}</span>
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() =>
                                  props.onPingServer(selected.server!.host, selected.server!.port)
                                }
                              >
                                <IconRefresh size={13} />
                                <span>Пинг</span>
                              </button>
                            </div>
                          </div>
                          {props.settings && (
                            <label className="row subtle" style={{ cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={props.settings.autoJoinServer}
                                onChange={(e) =>
                                  void props.onUpdateSettings({ autoJoinServer: e.target.checked })
                                }
                              />
                              <span>Подключаться к серверу при запуске игры</span>
                            </label>
                          )}
                        </div>
                      )
                    })()
                  ) : (
                    <div className="subtle">Для этой сборки сервер не указан.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {selected && conflictMode && selected.conflicts.length > 0 && (
        <ConflictModal
          packName={selected.name}
          conflicts={selected.conflicts}
          actionLabel={conflictMode === 'install' ? 'Применить и установить' : 'Применить и играть'}
          onCancel={() => setConflictMode(null)}
          onApply={(resolutions) => {
            const mode = conflictMode
            setConflictMode(null)
            if (mode === 'install') {
              void props.onInstallPack(selected.key, resolutions)
            } else {
              void props.onPlayPack(selected.key, { resolutions })
            }
          }}
        />
      )}
    </div>
  )
}
