import type { ErrorCode, UserError } from '@shared/types'

/** Ошибка с понятным пользователю текстом на русском. */
export class LauncherError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly title: string,
    message: string,
    public readonly hint?: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'LauncherError'
  }

  toUserError(): UserError {
    return { code: this.code, title: this.title, message: this.message, hint: this.hint }
  }
}

export class CancelledError extends LauncherError {
  constructor() {
    super('cancelled', 'Операция отменена', 'Операция отменена пользователем.', 'Нажмите кнопку ещё раз, чтобы продолжить с места остановки.')
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof CancelledError ||
    (e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR'))
  )
}

export function toUserError(e: unknown): UserError {
  if (e instanceof LauncherError) return e.toUserError()
  if (isAbortError(e)) return new CancelledError().toUserError()
  const err = e as NodeJS.ErrnoException
  if (err && typeof err === 'object' && err.code === 'ENOSPC') {
    return {
      code: 'disk-space',
      title: 'Недостаточно места на диске',
      message: 'Во время записи закончилось свободное место.',
      hint: 'Освободите место или выберите другую папку установки в настройках, затем повторите.'
    }
  }
  if (err && typeof err === 'object' && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY')) {
    return {
      code: 'filesystem',
      title: 'Нет доступа к файлу',
      message: `Не удалось изменить файл: ${err.path ?? 'неизвестный путь'} (${err.code}).`,
      hint: 'Закройте игру и программы, которые могут держать файл открытым (антивирус, архиватор), и повторите.'
    }
  }
  return {
    code: 'unknown',
    title: 'Непредвиденная ошибка',
    message: e instanceof Error ? e.message : String(e),
    hint: 'Повторите попытку. Если ошибка повторяется, экспортируйте диагностический отчёт в настройках.'
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}
