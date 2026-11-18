import { useEffect, useMemo, useRef, useState } from 'react'
import type { CrashReportView, LogEntry, PackSubfolder, PackView } from '@shared/types'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconCopy,
  IconFolder,
  IconPackage,
  IconRefresh,
  IconTerminal,
  IconTrash
} from '../components/Icons'

export interface PackCrashInfo {
  packKey: string
  exitCode: number | null
  crashReport: string | null
  crashReportPath: string | null
  ts: string
}

interface ConsolePageProps {
  packs: PackView[]
  selectedPackKey: string | null
  onSelectPack: (key: string) => void
  logs: LogEntry[]
  onClearLogs: () => void
  lastCrashByPack: Record<string, PackCrashInfo>
  onOpenFolder: (packKey: string, subfolder?: PackSubfolder) => void
  onLoadLatestCrashReport: (packKey: string) => Promise<CrashReportView | null>
}

export function ConsolePage(props: ConsolePageProps) {
  const [sourceFilter, setSourceFilter] = useState<'minecraft' | 'all'>('minecraft')
  const [levelFilter, setLevelFilter] = useState<'all' | 'warn' | 'error'>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copiedLogs, setCopiedLogs] = useState(false)
  const [copiedCrash, setCopiedCrash] = useState(false)
  const [loadedCrash, setLoadedCrash] = useState<CrashReportView | null>(null)
  const [loadingCrash, setLoadingCrash] = useState(false)
  const [crashMessage, setCrashMessage] = useState<string | null>(null)

  const logBoxRef = useRef<HTMLDivElement | null>(null)

  const selectedPack =
    props.packs.find((p) => p.key === props.selectedPackKey) ?? props.packs[0] ?? null
  const runningPacks = props.packs.filter((p) => p.status === 'running' || p.status === 'launching')
  const recentCrash = selectedPack ? props.lastCrashByPack[selectedPack.key] ?? null : null

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return props.logs.filter((entry) => {
      if (sourceFilter === 'minecraft' && entry.scope !== 'minecraft') return false
      if (levelFilter === 'warn' && entry.level !== 'warn' && entry.level !== 'error') return false
      if (levelFilter === 'error' && entry.level !== 'error') return false
      if (q && !entry.message.toLowerCase().includes(q) && !entry.scope.toLowerCase().includes(q)) {
        return false
      }
      return true
    })
  }, [props.logs, sourceFilter, levelFilter, search])

  useEffect(() => {
    if (!autoScroll || !logBoxRef.current) return
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [filteredLogs, autoScroll])

  useEffect(() => {
    setLoadedCrash(null)
    setCrashMessage(null)
  }, [selectedPack?.key])

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${l.ts.slice(11, 19)}] [${l.level.toUpperCase()}] [${l.scope}] ${l.message}`)
      .join('\n')
    navigator.clipboard.writeText(text).catch(() => undefined)
    setCopiedLogs(true)
    setTimeout(() => setCopiedLogs(false), 1800)
  }

  const crashContent = loadedCrash?.content ?? recentCrash?.crashReport ?? null

  const handleCopyCrash = () => {
    if (!crashContent) return
    navigator.clipboard.writeText(crashContent).catch(() => undefined)
    setCopiedCrash(true)
    setTimeout(() => setCopiedCrash(false), 1800)
  }

  const handleLoadLatestCrash = async () => {
    if (!selectedPack) return
    setLoadingCrash(true)
    setCrashMessage(null)
    try {
      const report = await props.onLoadLatestCrashReport(selectedPack.key)
      if (!report) {
        setLoadedCrash(null)
        setCrashMessage('Файлы краш-репортов в папке crash-reports/ пока не найдены.')
      } else {
        setLoadedCrash(report)
      }
    } catch (e) {
      setCrashMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingCrash(false)
    }
  }

  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="row-between">
          <div className="row" style={{ gap: 10 }}>
            <h3 className="section-header" style={{ margin: 0 }}>
              <IconTerminal size={18} />
              <span>Живая консоль игры</span>
            </h3>
            {runningPacks.length > 0 ? (
              <span className="badge badge-ok">
                <span className="status-dot dot-live" />
                <span>Запущена: {runningPacks.map((p) => p.name).join(', ')}</span>
              </span>
            ) : (
              <span className="badge badge-neutral">
                <span className="status-dot dot-idle" />
                <span>Игра сейчас не запущена</span>
              </span>
            )}
          </div>

          <div className="row">
            <button type="button" className="btn btn-sm" onClick={handleCopyLogs}>
              {copiedLogs ? <IconCheck size={13} /> : <IconCopy size={13} />}
              <span>{copiedLogs ? 'Скопировано' : 'Копировать лог'}</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={props.onClearLogs}>
              <IconTrash size={13} />
              <span>Очистить окно</span>
            </button>
          </div>
        </div>

        <div className="row-between">
          <div className="row">
            <button
              type="button"
              className={`btn btn-sm ${sourceFilter === 'minecraft' ? 'btn-primary' : ''}`}
              onClick={() => setSourceFilter('minecraft')}
            >
              Только Minecraft
            </button>
            <button
              type="button"
              className={`btn btn-sm ${sourceFilter === 'all' ? 'btn-primary' : ''}`}
              onClick={() => setSourceFilter('all')}
            >
              Весь лаунчер
            </button>
            <span className="subtle">|</span>
            {(
              [
                ['all', 'Все уровни'],
                ['warn', 'Warn + Error'],
                ['error', 'Только Error']
              ] as const
            ).map(([lvl, label]) => (
              <button
                key={lvl}
                type="button"
                className={`btn btn-sm ${levelFilter === lvl ? 'btn-primary' : ''}`}
                onClick={() => setLevelFilter(lvl)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="row">
            <input
              className="input"
              style={{ width: 220, padding: '6px 10px' }}
              placeholder="Поиск по консоли…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className="row subtle" style={{ cursor: 'pointer', gap: 6 }}>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>Автопрокрутка</span>
            </label>
          </div>
        </div>

        <div ref={logBoxRef} className="log-box" style={{ maxHeight: 360, minHeight: 240 }}>
          {filteredLogs.length === 0 ? (
            <div className="subtle">
              {sourceFilter === 'minecraft'
                ? 'Вывод Minecraft появится здесь в реальном времени сразу после запуска сборки.'
                : 'Записей по текущему фильтру пока нет.'}
            </div>
          ) : (
            filteredLogs.slice(-600).map((l, idx) => (
              <div
                key={idx}
                className={`log-line ${
                  l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : ''
                }`}
              >
                [{l.ts.slice(11, 19)}] [{l.level.toUpperCase()}] [{l.scope}] {l.message}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card stack">
        <div className="row-between">
          <div>
            <h3 className="section-header" style={{ marginBottom: 4 }}>
              <IconAlert size={18} />
              <span>Краш-логи и папки сборки</span>
            </h3>
            <div className="subtle">
              Быстрый переход к модам, скриншотам, обычным логам и отчётам об ошибках.
            </div>
          </div>
          {props.packs.length > 0 && (
            <select
              className="select"
              style={{ width: 250 }}
              value={selectedPack?.key ?? ''}
              onChange={(e) => props.onSelectPack(e.target.value)}
            >
              {props.packs.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedPack ? (
          <>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onOpenFolder(selectedPack.key, 'crash-reports')}
              >
                <IconAlert size={13} />
                <span>Открыть crash-reports/</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onOpenFolder(selectedPack.key, 'logs')}
              >
                <IconTerminal size={13} />
                <span>Открыть logs/</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onOpenFolder(selectedPack.key, 'mods')}
              >
                <IconPackage size={13} />
                <span>Открыть mods/</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onOpenFolder(selectedPack.key, 'screenshots')}
              >
                <IconCamera size={13} />
                <span>Открыть screenshots/</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onOpenFolder(selectedPack.key, 'root')}
              >
                <IconFolder size={13} />
                <span>Корневая папка</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={loadingCrash}
                onClick={() => void handleLoadLatestCrash()}
              >
                <IconRefresh size={13} className={loadingCrash ? 'spin-slow' : ''} />
                <span>{loadingCrash ? 'Чтение…' : 'Прочитать последний краш-лог'}</span>
              </button>
            </div>

            {crashMessage && <div className="subtle">{crashMessage}</div>}

            {(recentCrash || loadedCrash) && (
              <div className="stack-sm">
                <div className="row-between">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="badge badge-danger">
                      <IconAlert size={12} />
                      <span>
                        {loadedCrash
                          ? `Файл: ${loadedCrash.fileName}`
                          : `Код завершения: ${recentCrash?.exitCode ?? 'неизвестен'}`}
                      </span>
                    </span>
                    <span className="subtle">
                      {loadedCrash
                        ? new Date(loadedCrash.modifiedAt).toLocaleString('ru-RU')
                        : recentCrash?.ts
                          ? new Date(recentCrash.ts).toLocaleString('ru-RU')
                          : ''}
                    </span>
                  </div>
                  {crashContent && (
                    <button type="button" className="btn btn-sm" onClick={handleCopyCrash}>
                      {copiedCrash ? <IconCheck size={13} /> : <IconCopy size={13} />}
                      <span>{copiedCrash ? 'Скопировано' : 'Копировать краш-лог'}</span>
                    </button>
                  )}
                </div>

                {crashContent ? (
                  <div className="log-box" style={{ maxHeight: 280 }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>
                      {crashContent}
                    </pre>
                  </div>
                ) : (
                  <div className="banner banner-warn">
                    <span>
                      Minecraft завершился с кодом {recentCrash?.exitCode}, но файл краш-репорта не был
                      сформирован. Проверьте обычные логи игры выше или откройте папку `logs/`.
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="muted">Выберите или добавьте сборку в каталоге для доступа к папкам и краш-логам.</div>
        )}
      </div>
    </div>
  )
}
