import { useState, type FormEvent } from 'react'
import { GitBranch, Loader2, Plus, X } from 'lucide-react'

interface AddRepoModalProps {
  onClose: () => void
  onAdd: (repo: string, branch?: string) => Promise<void>
}

export function AddRepoModal({ onClose, onAdd }: AddRepoModalProps) {
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!repo.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(repo.trim(), branch.trim() || undefined)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-repo-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-[#0f1724] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h3 id="add-repo-title" className="text-base font-bold text-slate-900 dark:text-slate-100">
            Добавить сборку из GitHub
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть окно"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-6 space-y-4">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Укажите репозиторий с файлом <span className="font-mono-tabular">ForLauncher/pack.json</span>.
            Сборка сразу появится в левой панели библиотеки.
          </p>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Репозиторий или URL
            </label>
            <input
              type="text"
              required
              autoFocus
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo или https://github.com/owner/repo"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/80 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
              <GitBranch className="w-3.5 h-3.5 text-slate-400" />
              <span>Ветка (по умолчанию main)</span>
            </label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/80 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
          </div>

          {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              <span>{busy ? 'Добавление…' : 'Добавить сборку'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
