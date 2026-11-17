import type { UserError } from '@shared/types'

interface ErrorBannerProps {
  error: UserError
  onRetry?: () => void
  retryLabel?: string
}

export function ErrorBanner({ error, onRetry, retryLabel = 'Повторить' }: ErrorBannerProps) {
  return (
    <div className="banner banner-error" role="alert">
      <div className="row-between">
        <strong>{error.title}</strong>
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </div>
      <div>{error.message}</div>
      {error.hint && <div className="subtle">{error.hint}</div>}
    </div>
  )
}
