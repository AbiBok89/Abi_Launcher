import { createWriteStream } from 'node:fs'
import { rename, stat, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isAllowedUrl } from '@shared/schemas'
import { LauncherError, CancelledError, isAbortError, throwIfAborted } from './errors'
import { sha256File } from './hash'
import { logger } from './log'

const log = logger.scope('http')

export const USER_AGENT = 'AbiLauncher (+https://github.com/AbiBok89/Abi_Launcher)'

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Своя проверка хоста (по умолчанию — список разрешённых хостов GitHub). */
  isAllowed?: (url: string) => boolean
  headers?: Record<string, string>
}

function describeNetworkError(e: unknown, url: string): LauncherError {
  const cause = (e as { cause?: { code?: string } })?.cause
  const code = cause?.code ?? (e as { code?: string })?.code
  const host = safeHost(url)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new LauncherError(
      'offline',
      'Нет подключения к интернету',
      `Не удалось найти сервер ${host}. Похоже, нет интернета или не работает DNS.`,
      'Проверьте подключение и нажмите «Повторить проверку».',
      { cause: e }
    )
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || (e as Error)?.name === 'TimeoutError') {
    return new LauncherError(
      'github-unavailable',
      'Сервер не отвечает',
      `${host} не ответил вовремя.`,
      'Проверьте интернет, VPN или прокси и повторите попытку.',
      { cause: e }
    )
  }
  return new LauncherError(
    'github-unavailable',
    'Сервер недоступен',
    `Не удалось подключиться к ${host}${code ? ` (${code})` : ''}.`,
    'Проверьте подключение к интернету и повторите попытку.',
    { cause: e }
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function describeHttpStatus(status: number, url: string): LauncherError {
  const host = safeHost(url)
  if (status === 404) {
    return new LauncherError(
      'github-unavailable',
      'Файл не найден',
      `Сервер ${host} ответил «не найдено» (404) для ${url}.`,
      'Проверьте адрес репозитория и что файл опубликован (релиз не в статусе черновика).'
    )
  }
  if (status === 403 || status === 429) {
    return new LauncherError(
      'github-unavailable',
      'Превышен лимит запросов',
      `${host} временно ограничил запросы (HTTP ${status}).`,
      'Подождите несколько минут и повторите попытку.'
    )
  }
  return new LauncherError(
    'github-unavailable',
    'Ошибка сервера',
    `${host} вернул HTTP ${status}.`,
    'Повторите попытку позже.'
  )
}

/**
 * fetch с ручной обработкой редиректов: каждый адрес в цепочке проверяется
 * по списку разрешённых хостов, чтобы манифест не мог увести загрузку куда угодно.
 */
export async function safeFetch(url: string, opts: RequestOptions & { method?: string } = {}): Promise<Response> {
  const isAllowed = opts.isAllowed ?? isAllowedUrl
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let current = url
  for (let hop = 0; hop < 6; hop++) {
    if (!isAllowed(current)) {
      throw new LauncherError(
        'manifest-invalid',
        'Запрещённый адрес загрузки',
        `Адрес ${current} не входит в список разрешённых.`,
        'Владелец сборки должен размещать файлы на GitHub (Releases или raw).'
      )
    }
    let res: Response
    try {
      res = await fetch(current, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache', ...opts.headers }
      })
    } catch (e) {
      if (opts.signal?.aborted) throw new CancelledError()
      throw describeNetworkError(e, current)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined)
      current = new URL(res.headers.get('location')!, current).toString()
      continue
    }
    return res
  }
  throw new LauncherError('github-unavailable', 'Слишком много перенаправлений', `Адрес ${url} перенаправляет по кругу.`)
}

export async function fetchText(url: string, opts: RequestOptions & { maxBytes?: number } = {}): Promise<string> {
  const res = await safeFetch(url, opts)
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw describeHttpStatus(res.status, url)
  }
  const buf = await readLimited(res, opts.maxBytes ?? 32 * 1024 * 1024)
  return buf.toString('utf8')
}

export async function fetchBuffer(url: string, opts: RequestOptions & { maxBytes?: number } = {}): Promise<{ data: Buffer; contentType: string }> {
  const res = await safeFetch(url, opts)
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw describeHttpStatus(res.status, url)
  }
  return { data: await readLimited(res, opts.maxBytes ?? 8 * 1024 * 1024), contentType: res.headers.get('content-type') ?? '' }
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new LauncherError('manifest-invalid', 'Слишком большой ответ', `Ответ сервера превышает ${maxBytes} байт.`)
  const chunks: Buffer[] = []
  let total = 0
  if (!res.body) return Buffer.alloc(0)
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new LauncherError('manifest-invalid', 'Слишком большой ответ', `Ответ сервера превышает ${maxBytes} байт.`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export interface DownloadOptions extends RequestOptions {
  expectedSize: number
  expectedSha256: string
  /** Вызывается с количеством новых байт. */
  onBytes?: (delta: number) => void
  attempts?: number
}

/**
 * Скачивает файл в `dest` через `dest.part` с докачкой (HTTP Range) и проверкой
 * размера и SHA-256. Итоговый файл появляется только после успешной проверки.
 */
export async function downloadVerified(url: string, dest: string, opts: DownloadOptions): Promise<void> {
  const attempts = opts.attempts ?? 4
  const part = dest + '.part'
  await mkdir(dirname(dest), { recursive: true })
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(opts.signal)
    try {
      await downloadOnce(url, part, opts)
      const st = await stat(part)
      if (st.size !== opts.expectedSize) {
        await unlink(part).catch(() => undefined)
        throw new LauncherError('integrity', 'Повреждённый файл', `Размер ${url} не совпал: ${st.size} вместо ${opts.expectedSize}.`)
      }
      const hash = await sha256File(part, opts.signal)
      if (hash !== opts.expectedSha256) {
        await unlink(part).catch(() => undefined)
        throw new LauncherError(
          'integrity',
          'Повреждённый файл',
          `Контрольная сумма файла ${safeName(dest)} не совпала с манифестом.`,
          'Файл будет скачан заново. Если ошибка повторяется — владельцу сборки нужно пересобрать манифест.'
        )
      }
      await rename(part, dest)
      return
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) throw new CancelledError()
      lastError = e
      const retriable = !(e instanceof LauncherError) || e.code !== 'manifest-invalid'
      if (!retriable || attempt === attempts) break
      const delay = Math.min(8000, 500 * 2 ** (attempt - 1))
      log.warn(`Повтор загрузки ${safeName(dest)} через ${delay} мс (попытка ${attempt + 1}/${attempts})`, e)
      await sleep(delay, opts.signal)
    }
  }
  if (lastError instanceof LauncherError) {
    if (lastError.code === 'integrity' || lastError.code === 'manifest-invalid') throw lastError
    throw new LauncherError('download-failed', 'Не удалось скачать файл', `${safeName(dest)}: ${lastError.message}`, 'Скачанные части сохранены — нажмите «Повторить», загрузка продолжится.', { cause: lastError })
  }
  throw new LauncherError('download-failed', 'Не удалось скачать файл', `${safeName(dest)}: ${(lastError as Error)?.message ?? lastError}`, 'Нажмите «Повторить», загрузка продолжится.', { cause: lastError })
}

function safeName(p: string): string {
  return p.split(/[\\/]/).slice(-2).join('/')
}

async function downloadOnce(url: string, part: string, opts: DownloadOptions): Promise<void> {
  let existing = 0
  try {
    existing = (await stat(part)).size
  } catch {
    existing = 0
  }
  if (existing > opts.expectedSize) {
    await unlink(part)
    existing = 0
  }
  if (existing === opts.expectedSize && existing > 0) return
  const headers: Record<string, string> = {}
  if (existing > 0) headers.Range = `bytes=${existing}-`
  const res = await safeFetch(url, { ...opts, headers, timeoutMs: opts.timeoutMs ?? 30 * 60_000 })
  if (res.status === 416) {
    // Range за пределами файла — начинаем заново
    await res.body?.cancel().catch(() => undefined)
    await unlink(part).catch(() => undefined)
    throw new LauncherError('download-failed', 'Ошибка докачки', 'Сервер отклонил продолжение загрузки, начнём заново.')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw describeHttpStatus(res.status, url)
  }
  const append = res.status === 206 && existing > 0
  if (!append && existing > 0) {
    opts.onBytes?.(-existing)
    existing = 0
  }
  if (!res.body) throw new LauncherError('download-failed', 'Пустой ответ', `Сервер вернул пустой ответ для ${url}.`)
  let written = existing
  const limit = opts.expectedSize
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length
      if (written > limit) {
        cb(new LauncherError('integrity', 'Повреждённый файл', 'Сервер прислал больше данных, чем указано в манифесте.'))
        return
      }
      opts.onBytes?.(chunk.length)
      cb(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(res.body as never),
    counter,
    createWriteStream(part, { flags: append ? 'a' : 'w' }),
    { signal: opts.signal }
  )
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
