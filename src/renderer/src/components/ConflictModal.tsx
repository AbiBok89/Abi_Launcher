import { useState } from 'react'
import { AlertTriangle, Check, Shield, X } from 'lucide-react'
import type { ConflictChoice, ConflictView } from '@shared/types'

interface ConflictModalProps {
  packName: string
  conflicts: ConflictView[]
  actionLabel: string
  onCancel: () => void
  onApply: (resolutions: Record<string, ConflictChoice>) => void
}

const KIND_LABELS: Record<ConflictView['kind'], string> = {
  modified: 'Изменён игроком',
  untracked: 'Уже есть на диске (не изменён лаунчером)',
  'obsolete-modified': 'Удалён в новой версии сборки, но изменён игроком'
}

export function ConflictModal({
  packName,
  conflicts,
  actionLabel,
  onCancel,
  onApply
}: ConflictModalProps) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>(() => {
    const init: Record<string, ConflictChoice> = {}
    for (const c of conflicts) init[c.path] = 'replace'
    return init
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
    >
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-[#0f1724] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3
              id="conflict-modal-title"
              className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2"
            >
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <span>Конфликт изменённых файлов — {packName}</span>
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Обнаружены файлы сборки, которые отличаются от версии в манифесте. Перед заменой или
              удалением лаунчер автоматически сохранит вашу копию в{' '}
              <span className="font-mono-tabular">.abilauncher/backups</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Закрыть окно конфликтов"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {conflicts.map((c) => {
            const val = choices[c.path] ?? 'replace'
            return (
              <div
                key={c.path}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono-tabular text-xs font-semibold text-slate-900 dark:text-slate-100 break-all">
                    {c.path}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                      c.canKeep
                        ? 'text-sky-700 dark:text-sky-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {c.canKeep ? (
                      <Shield className="w-3.5 h-3.5" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5" />
                    )}
                    <span>{c.canKeep ? 'Необязательный' : 'Обязательный файл'}</span>
                  </span>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {KIND_LABELS[c.kind]}
                </div>
                <div className="flex flex-wrap items-center gap-4 pt-1 text-xs">
                  <label className="inline-flex items-center gap-2 text-slate-800 dark:text-slate-200 cursor-pointer">
                    <input
                      type="radio"
                      name={`conflict-${c.path}`}
                      checked={val === 'replace'}
                      onChange={() => setChoices((prev) => ({ ...prev, [c.path]: 'replace' }))}
                      className="accent-emerald-600 dark:accent-emerald-500"
                    />
                    <span>
                      {c.kind === 'obsolete-modified'
                        ? 'Удалить с резервной копией'
                        : 'Заменить версией из сборки (с бэкапом)'}
                    </span>
                  </label>
                  {c.canKeep ? (
                    <label className="inline-flex items-center gap-2 text-slate-800 dark:text-slate-200 cursor-pointer">
                      <input
                        type="radio"
                        name={`conflict-${c.path}`}
                        checked={val === 'keep'}
                        onChange={() => setChoices((prev) => ({ ...prev, [c.path]: 'keep' }))}
                        className="accent-emerald-600 dark:accent-emerald-500"
                      />
                      <span>Оставить мою версию</span>
                    </label>
                  ) : (
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      Обязательный файл нельзя пропустить: несовпадение блокирует запуск.
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2.5 bg-slate-50/70 dark:bg-slate-900/40">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => onApply(choices)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{actionLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
