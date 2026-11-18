import type { UserError } from '@shared/types'
import { IconError, IconRefresh } from './Icons'

interface ErrorBannerProps {
  error: UserError
  onRetry?: () => void
  retryLabel?: string
}

export function ErrorBanner({ error, onRetry, retryLabel = 'Повторить' }: ErrorBannerProps) {
  return (
    <div className="banner banner-error" role="alert">
      <div className="row-between">
        <div className="row" style={{ gap: 8 }}>
          <IconError size={16} />
          <strong>{error.title}</strong>
        </div>
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <IconRefresh size={13} />
            <span>{retryLabel}</span>
          </button>
        )}
      </div>
      <div>{error.message}</div>
      {error.hint && <div className="subtle">{error.hint}</div>}
    </div>
  )
}
