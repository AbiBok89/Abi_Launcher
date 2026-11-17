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

export const STATUS_LABELS: Record<PackStatus, { label: string; tone: 'ok' | 'info' | 'warn' | 'danger' | 'neutral' }> = {
  'not-installed': { label: 'Не установлена', tone: 'neutral' },
  checking: { label: 'Проверяется…', tone: 'info' },
  downloading: { label: 'Загружается…', tone: 'info' },
  'update-available': { label: 'Требует обновления', tone: 'warn' },
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return isoDate
  return `${m[3]}.${m[2]}.${m[1]}`
}

export function formatServerAddress(host: string, port?: number): string {
  return port && port !== 25565 ? `${host}:${port}` : host
}
