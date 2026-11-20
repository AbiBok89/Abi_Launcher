import { formatMemoryGb } from '../utils/format'

interface MemoryAllocationBarProps {
  activeMemoryMb: number
  recommendedMemoryMb?: number
  systemMemoryMb: number
  compact?: boolean
}

export function MemoryAllocationBar({
  activeMemoryMb,
  recommendedMemoryMb,
  systemMemoryMb,
  compact = false
}: MemoryAllocationBarProps) {
  const safeSystemMb = Math.max(systemMemoryMb, activeMemoryMb, recommendedMemoryMb ?? 0, 2048)
  const currentPct = Math.min(100, Math.round((activeMemoryMb / safeSystemMb) * 100))
  const clampedRecommended =
    typeof recommendedMemoryMb === 'number'
      ? Math.min(recommendedMemoryMb, Math.max(2048, safeSystemMb - 2048))
      : undefined
  const hasAutoFixPreview =
    typeof clampedRecommended === 'number' && clampedRecommended > activeMemoryMb
  const targetMemoryMb = hasAutoFixPreview ? clampedRecommended : activeMemoryMb
  const targetPct = Math.min(100, Math.round((targetMemoryMb / safeSystemMb) * 100))
  const deltaPct = Math.max(0, targetPct - currentPct)
  const remainingForOsMb = Math.max(0, safeSystemMb - targetMemoryMb)
  const remainingPct = Math.max(0, 100 - targetPct)

  const isOverloaded = activeMemoryMb / safeSystemMb > 0.78
  const isUnderRecommended = hasAutoFixPreview

  const barToneClass = isOverloaded
    ? 'bg-rose-500 dark:bg-rose-500'
    : isUnderRecommended
      ? 'bg-amber-500 dark:bg-amber-400'
      : 'bg-emerald-600 dark:bg-emerald-500'

  const statusText = isOverloaded
    ? `Слишком много: системе останется только ${formatMemoryGb(remainingForOsMb)}`
    : isUnderRecommended
      ? `После автофикса: ${formatMemoryGb(targetMemoryMb)} (${targetPct}% из ${formatMemoryGb(safeSystemMb)}) · системе останется ${formatMemoryGb(remainingForOsMb)}`
      : `Оптимально: ${currentPct}% из ${formatMemoryGb(safeSystemMb)} · системе останется ${formatMemoryGb(remainingForOsMb)} (${remainingPct}%)`

  const statusToneClass = isOverloaded
    ? 'text-rose-600 dark:text-rose-400'
    : isUnderRecommended
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-slate-600 dark:text-slate-400'

  return (
    <div
      className={compact ? 'space-y-1.5 pt-1.5' : 'space-y-2 pt-1'}
      aria-label="Шкала использования оперативной памяти"
    >
      <div className="relative">
        <div
          className={`w-full rounded-full bg-slate-200 dark:bg-slate-800/90 overflow-hidden flex ${
            compact ? 'h-2' : 'h-2.5'
          }`}
        >
          <div
            className={`h-full transition-[width] duration-200 ${barToneClass}`}
            style={{ width: `${currentPct}%` }}
          />
          {deltaPct > 0 && (
            <div
              title={`Дополнительные ${formatMemoryGb(targetMemoryMb - activeMemoryMb)} после автофикса`}
              className="h-full bg-emerald-500/40 dark:bg-emerald-400/35 border-l border-dashed border-emerald-600 dark:border-emerald-300 transition-[width] duration-200"
              style={{ width: `${deltaPct}%` }}
            />
          )}
        </div>

        {typeof clampedRecommended === 'number' && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-emerald-700 dark:bg-emerald-300 rounded-full"
            style={{
              left: `calc(${Math.min(100, Math.round((clampedRecommended / safeSystemMb) * 100))}% - 1px)`
            }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
        <span className={`font-medium ${statusToneClass}`}>{statusText}</span>

        <div className="flex items-center gap-2 font-mono-tabular text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
          {hasAutoFixPreview ? (
            <span>
              Сейчас {currentPct}% →{' '}
              <strong className="text-emerald-700 dark:text-emerald-400">{targetPct}%</strong>
            </span>
          ) : (
            <span>
              Занято {formatMemoryGb(activeMemoryMb)} / {formatMemoryGb(safeSystemMb)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
