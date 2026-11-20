import { AlertCircle, RefreshCw } from 'lucide-react'
import type { UserError } from '@shared/types'

interface ErrorBannerProps {
  error: UserError
  onRetry?: () => void
  retryLabel?: string
}

export function ErrorBanner({ error, onRetry, retryLabel = 'Повторить' }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="p-4 rounded-xl border border-rose-500/40 bg-rose-500/[0.08] flex flex-wrap items-start justify-between gap-4"
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <AlertCircle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
        <div className="space-y-1 min-w-0">
          <div className="text-xs font-bold text-rose-800 dark:text-rose-300">{error.title}</div>
          <div className="text-xs text-slate-700 dark:text-slate-200 break-words">
            {error.message}
          </div>
          {error.hint && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">{error.hint}</div>
          )}
        </div>
      </div>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-300 hover:bg-rose-500/15 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>{retryLabel}</span>
        </button>
      )}
    </div>
  )
}
