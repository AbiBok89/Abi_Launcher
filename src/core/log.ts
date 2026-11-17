import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir, userInfo } from 'node:os'
import type { LogEntry } from '@shared/types'

type Listener = (entry: LogEntry) => void

const MAX_BUFFER = 3000
const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * Простой логгер: кольцевой буфер для интерфейса + файл с ротацией.
 * Пути домашнего каталога и имя пользователя ОС заменяются на плейсхолдеры,
 * чтобы логи можно было безопасно прикладывать к отчётам.
 */
class Logger {
  private buffer: LogEntry[] = []
  private listeners = new Set<Listener>()
  private file: string | null = null
  private redactions: Array<[RegExp, string]> = []

  constructor() {
    this.addRedaction(homedir(), '~')
    try {
      const name = userInfo().username
      if (name && name.length >= 3) this.addRedaction(name, '<user>')
    } catch {
      /* ignore */
    }
  }

  addRedaction(value: string, replacement: string): void {
    if (!value) return
    const variants = new Set([value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')])
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      this.redactions.push([new RegExp(escaped, 'gi'), replacement])
    }
    // Длинные значения применяем раньше коротких.
    this.redactions.sort((a, b) => b[0].source.length - a[0].source.length)
  }

  redact(text: string): string {
    let out = text
    for (const [re, rep] of this.redactions) out = out.replace(re, rep)
    // Токены и ключи на всякий случай
    out = out.replace(/(access[_-]?token|authorization|token)(["'=:\s]+)([^\s"',]+)/gi, '$1$2<скрыто>')
    return out
  }

  setFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
    this.file = path
  }

  onEntry(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  entries(): LogEntry[] {
    return [...this.buffer]
  }

  log(level: LogEntry['level'], scope: string, message: string, err?: unknown): void {
    let text = message
    if (err !== undefined) {
      const e = err as Error
      text += `: ${e?.stack ?? e?.message ?? String(err)}`
    }
    const entry: LogEntry = { ts: new Date().toISOString(), level, scope, message: this.redact(text) }
    this.buffer.push(entry)
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER)
    for (const l of this.listeners) {
      try {
        l(entry)
      } catch {
        /* ignore */
      }
    }
    if (level !== 'debug' || process.env.ABI_DEBUG) {
      const line = `${entry.ts} [${level.toUpperCase()}] [${scope}] ${entry.message}\n`
      if (process.env.NODE_ENV !== 'test') process.stdout.write?.(line)
      this.writeFile(line)
    }
  }

  private writeFile(line: string): void {
    if (!this.file) return
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_FILE_BYTES) {
        const old = this.file + '.1'
        if (existsSync(old)) unlinkSync(old)
        renameSync(this.file, old)
      }
      appendFileSync(this.file, line, 'utf8')
    } catch {
      /* логирование не должно ронять приложение */
    }
  }

  scope(name: string) {
    return {
      debug: (m: string, e?: unknown) => this.log('debug', name, m, e),
      info: (m: string, e?: unknown) => this.log('info', name, m, e),
      warn: (m: string, e?: unknown) => this.log('warn', name, m, e),
      error: (m: string, e?: unknown) => this.log('error', name, m, e)
    }
  }
}

export const logger = new Logger()
export type ScopedLogger = ReturnType<Logger['scope']>
