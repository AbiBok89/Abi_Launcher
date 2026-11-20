import { ArrowUpCircle, CheckCircle2, Download, Loader2, X, XCircle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { PackView, ProgressEvent } from '@shared/types'
import { STAGE_LABELS, formatBytes, formatSpeed } from '../utils/format'

export interface CompletedTaskItem {
  id: string
  packName: string
  action: string
  finishedAt: string
  status: 'ok' | 'error'
}

interface DownloadsDrawerProps {
  open: boolean
  onClose: () => void
  packs: PackView[]
  progressByPack: Record<string, ProgressEvent>
  completedTasks: CompletedTaskItem[]
  onCancelOp: (packKey: string) => void
  onTriggerUpdate: (packKey: string) => void
  onSelectPack: (packKey: string) => void
}

export function DownloadsDrawer({
  open,
  onClose,
  packs,
  progressByPack,
  completedTasks,
  onCancelOp,
  onTriggerUpdate,
  onSelectPack
}: DownloadsDrawerProps) {
  const activeOps = Object.values(progressByPack)
  const pendingUpdates = packs.filter(
    (p) => (p.status === 'update-available' || p.status === 'conflict') && !progressByPack[p.key]
  )

  return (
    <AnimatePresence>
      {open && (
        <div className="absolute inset-0 z-30 flex justify-end overflow-hidden">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="flex-1 bg-slate-950/35 backdrop-blur-[1px]"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            aria-label="Загрузки и задачи"
            className="w-full max-w-md h-full bg-white dark:bg-[#0d1420] border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  Загрузки и задачи
                </h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть панель загрузок"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {/* Active operations */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Активные операции
                  </h4>
                  <span className="text-xs font-mono-tabular text-slate-500 dark:text-slate-400">
                    {activeOps.length}
                  </span>
                </div>

                {activeOps.length === 0 ? (
                  <div className="py-6 px-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-center text-xs text-slate-500 dark:text-slate-400">
                    Нет активных загрузок. Установите сборку или запустите проверку — прогресс
                    отобразится здесь без ухода с текущей страницы.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {activeOps.map((op) => {
                      const packName = packs.find((p) => p.key === op.packKey)?.name ?? op.packKey
                      const percent =
                        op.bytesTotal > 0
                          ? Math.min(100, Math.round((op.bytesDone / op.bytesTotal) * 100))
                          : op.filesTotal > 0
                            ? Math.min(100, Math.round((op.filesDone / op.filesTotal) * 100))
                            : null

                      return (
                        <div
                          key={op.packKey}
                          className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 space-y-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                onSelectPack(op.packKey)
                                onClose()
                              }}
                              className="text-xs font-bold text-slate-900 dark:text-slate-100 hover:text-emerald-600 dark:hover:text-emerald-400 truncate text-left"
                            >
                              {packName}
                            </button>
                            {op.cancellable && (
                              <button
                                type="button"
                                onClick={() => onCancelOp(op.packKey)}
                                className="text-xs font-medium text-rose-600 dark:text-rose-400 hover:underline whitespace-nowrap shrink-0"
                              >
                                Отменить
                              </button>
                            )}
                          </div>

                          <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
                            <span className="inline-flex items-center gap-1.5">
                              <Loader2 className="w-3 h-3 animate-spin text-emerald-500" />
                              {STAGE_LABELS[op.stage]}
                            </span>
                            <span className="font-mono-tabular">
                              {percent !== null ? `${percent}%` : '…'}
                              {op.speed > 0 ? ` · ${formatSpeed(op.speed)}` : ''}
                            </span>
                          </div>

                          <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full bg-emerald-600 dark:bg-emerald-500 transition-[width] duration-200 ${
                                percent === null ? 'w-1/3 animate-pulse' : ''
                              }`}
                              style={percent !== null ? { width: `${percent}%` } : undefined}
                            />
                          </div>

                          <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 gap-2">
                            <span className="truncate">{op.label}</span>
                            <span className="font-mono-tabular whitespace-nowrap shrink-0">
                              {op.bytesTotal > 0
                                ? `${formatBytes(op.bytesDone)} / ${formatBytes(op.bytesTotal)}`
                                : op.filesTotal > 0
                                  ? `${op.filesDone} / ${op.filesTotal} файлов`
                                  : ''}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* Available updates */}
              {pendingUpdates.length > 0 && (
                <section className="space-y-3">
                  <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Требуют внимания ({pendingUpdates.length})
                  </h4>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    {pendingUpdates.map((pack) => (
                      <div
                        key={pack.key}
                        className="p-3.5 flex items-center justify-between gap-3 bg-white dark:bg-slate-900/40"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {pack.name}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-tabular">
                            {pack.installedVersion ?? '—'} → {pack.version}
                            {pack.conflicts.length > 0 ? ` · ${pack.conflicts.length} конфл.` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onTriggerUpdate(pack.key)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap shrink-0"
                        >
                          <ArrowUpCircle className="w-3.5 h-3.5" />
                          <span>{pack.conflicts.length > 0 ? 'Решить' : 'Обновить'}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Completed history */}
              <section className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Недавние операции за сессию
                </h4>
                {completedTasks.length === 0 ? (
                  <div className="text-xs text-slate-400 dark:text-slate-500">
                    Завершённые операции этой сессии появятся здесь.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                    {completedTasks.map((task) => (
                      <div
                        key={task.id}
                        className="py-2.5 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {task.status === 'ok' ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                              {task.packName}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {task.action}
                            </div>
                          </div>
                        </div>
                        <span className="text-[11px] font-mono-tabular text-slate-400 shrink-0">
                          {task.finishedAt}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}
