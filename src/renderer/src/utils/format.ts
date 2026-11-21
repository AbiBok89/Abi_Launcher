import type { Loader } from '@shared/schemas'
import type { PackStatus, Stage } from '@shared/types'

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 Б'
  if (n < 1024) return `${n} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
  return `${formatBytes(bytesPerSec)}/с`
}

export function formatMemoryGb(mb: number): string {
  const gb = mb / 1024
  return `${Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1)} ГБ`
}

export function formatLoader(loader: Loader): string {
  switch (loader.type) {
    case 'vanilla':
      return 'Обычный (Vanilla)'
    case 'fabric':
      return `Fabric ${loader.version}`
    case 'forge':
      return `Forge ${loader.version}`
    case 'neoforge':
      return `NeoForge ${loader.version}`
  }
}

export function requiredJavaMajorForMinecraft(minecraftVersion: string): number {
  const match = /^1\.(\d+)(?:\.(\d+))?/.exec(minecraftVersion.trim())
  if (!match) return 21
  const minor = Number(match[1])
  const patch = match[2] ? Number(match[2]) : 0
  if (minor <= 16) return 8
  if (minor < 20 || (minor === 20 && patch <= 4)) return 17
  return 21
}

export function formatPackVersion(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) return '—'
  return /^[vV]/.test(trimmed) ? trimmed : `v${trimmed}`
}

export const STATUS_LABELS: Record<
  PackStatus,
  { label: string; tone: 'ok' | 'info' | 'warn' | 'danger' | 'neutral' }
> = {
  'not-installed': { label: 'Не установлена', tone: 'neutral' },
  checking: { label: 'Проверяется…', tone: 'info' },
  downloading: { label: 'Загружается…', tone: 'info' },
  'update-available': { label: 'Требуется обновление', tone: 'warn' },
  ready: { label: 'Готова', tone: 'ok' },
  conflict: { label: 'Конфликт файлов', tone: 'warn' },
  error: { label: 'Ошибка', tone: 'danger' },
  launching: { label: 'Запускается…', tone: 'info' },
  running: { label: 'В игре', tone: 'ok' }
}

export const STAGE_LABELS: Record<Stage, string> = {
  check: 'Проверка через GitHub',
  verify: 'Проверка файлов сборки',
  download: 'Загрузка файлов',
  extract: 'Распаковка архивов',
  apply: 'Применение обновления',
  java: 'Подготовка Java',
  minecraft: 'Установка Minecraft',
  loader: 'Установка загрузчика модов',
  launch: 'Запуск игры'
}

export function formatDateRu(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate)
  if (!m) return isoDate
  return `${m[3]}.${m[2]}.${m[1]}`
}

export function formatTimeRu(isoOrTs: string): string {
  const d = new Date(isoOrTs)
  if (Number.isNaN(d.getTime())) return isoOrTs
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDateTimeRu(isoOrTs: string): string {
  const d = new Date(isoOrTs)
  if (Number.isNaN(d.getTime())) return isoOrTs
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatServerAddress(host: string, port?: number): string {
  return port && port !== 25565 ? `${host}:${port}` : host
}
