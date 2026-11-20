import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, FolderOpen, Search, Terminal, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { LogEntry, PackSubfolder, PackView } from '@shared/types'
import { formatTimeRu } from '../utils/format'

export interface PackCrashInfo {
  packKey: string
  exitCode: number | null
  crashReport: string | null
  crashReportPath: string | null
  ts: string
}

type ScopeFilter = 'all' | 'minecraft' | 'launcher' | 'error'

interface ConsoleDrawerProps {
  open: boolean
  onClose: () => void
  packs: PackView[]
  logs: LogEntry[]
  crashes: PackCrashInfo[]
  onClearLogs: () => void
  onClearCrash: (packKey: string) => void
  onOpenFolder: (packKey: string, subfolder?: PackSubfolder) => void
  onCopyNotice: () => void
}

export function ConsoleDrawer({
  open,
  onClose,
  packs,
  logs,
  crashes,
  onClearLogs,
  onClearCrash,
  onOpenFolder,
  onCopyNotice
}: ConsoleDrawerProps) {
  const [filter, setFilter] = useState<ScopeFilter>('all')
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((entry) => {
      if (filter === 'minecraft' && entry.scope !== 'minecraft') return false
      if (filter === 'launcher' && entry.scope === 'minecraft') return false
      if (filter === 'error' && entry.level !== 'error' && entry.level !== 'warn') return false
      if (
        q &&
        !entry.message.toLowerCase().includes(q) &&
        !entry.scope.toLowerCase().includes(q)
      ) {
        return false
      }
      return true
    })
  }, [filter, logs, query])

  useEffect(() => {
    if (!open || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [open, filteredLogs.length])

  const handleCopy = () => {
    const text = filteredLogs
      .map((l) => `[${formatTimeRu(l.ts)}] [${l.level.toUpperCase()}/${l.scope}] ${l.message}`)
      .join('\n')
    navigator.clipboard?.writeText(text).catch(() => undefined)
    setCopied(true)
    onCopyNotice()
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ y: '100%', opacity: 0.7 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '100%', opacity: 0.7 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-x-0 bottom-0 z-30 h-[56%] min-h-[280px] max-h-[450px] flex flex-col bg-white dark:bg-[#0a1019] border-t border-slate-300 dark:border-slate-700/90 shadow-2xl"
        >
          <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50 dark:bg-[#0e1522]">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-slate-100">
                <Terminal className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Консоль игры и лаунчера</span>
              </div>

              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-200/70 dark:bg-slate-800/80">
                {(
                  [
                    ['all', 'Все'],
                    ['minecraft', 'Minecraft'],
                    ['launcher', 'Лаунчер'],
                    ['error', 'Ошибки']
                  ] as Array<[ScopeFilter, string]>
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      filter === id
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск в логах…"
                  className="w-44 pl-8 pr-2.5 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copied ? 'Скопировано' : 'Копировать'}</span>
              </button>

              <button
                type="button"
                onClick={onClearLogs}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Очистить</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                aria-label="Свернуть консоль"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 font-mono-tabular text-xs">
            {crashes.length > 0 && (
              <div className="space-y-2">
                {crashes.map((crash) => {
                  const packName = packs.find((p) => p.key === crash.packKey)?.name ?? crash.packKey
                  return (
                    <div
                      key={crash.packKey}
                      className="p-3.5 rounded-lg border border-rose-500/35 bg-rose-500/[0.07] text-slate-800 dark:text-slate-200 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 font-sans">
                        <div className="flex items-center gap-2 text-xs font-bold text-rose-700 dark:text-rose-400">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          <span>
                            Краш-репорт {packName} (код {crash.exitCode ?? '?'}) ·{' '}
                            {formatTimeRu(crash.ts)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenFolder(crash.packKey, 'crash-reports')}
                            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                            <span>crash-reports/</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onClearCrash(crash.packKey)}
                            className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                          >
                            Скрыть
                          </button>
                        </div>
                      </div>
                      {crash.crashReport && (
                        <pre className="text-[11px] leading-relaxed whitespace-pre-wrap text-rose-900/90 dark:text-rose-200/90 overflow-x-auto max-h-48 overflow-y-auto">
                          {crash.crashReport.slice(0, 4000)}
                        </pre>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {filteredLogs.length === 0 ? (
              <div className="py-10 text-center font-sans text-xs text-slate-500 dark:text-slate-400">
                Нет записей по выбранному фильтру. Запустите игру или проверьте файлы сборки.
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredLogs.map((entry, idx) => {
                  const isErr = entry.level === 'error'
                  const isWarn = entry.level === 'warn'
                  const isMc = entry.scope === 'minecraft'
                  return (
                    <div
                      key={`${entry.ts}-${idx}`}
                      className="flex items-start gap-2.5 leading-relaxed hover:bg-slate-100/70 dark:hover:bg-slate-800/40 px-1.5 py-0.5 rounded"
                    >
                      <span className="text-slate-400 dark:text-slate-500 shrink-0">
                        {formatTimeRu(entry.ts)}
                      </span>
                      <span
                        className={`shrink-0 font-semibold w-24 truncate ${
                          isErr
                            ? 'text-rose-600 dark:text-rose-400'
                            : isWarn
                              ? 'text-amber-600 dark:text-amber-400'
                              : isMc
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-sky-600 dark:text-sky-400'
                        }`}
                      >
                        [{entry.scope}]
                      </span>
                      <span className="text-slate-800 dark:text-slate-200 break-words flex-1">
                        {entry.message}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
