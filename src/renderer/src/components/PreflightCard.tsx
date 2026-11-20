import { AlertTriangle, CheckCircle2, Cpu, MemoryStick, User, Wrench } from 'lucide-react'
import { formatMemoryGb } from '../utils/format'
import { MemoryAllocationBar } from './MemoryAllocationBar'
import { Tooltip } from './Tooltip'

export interface PackPreflightStatus {
  requiredJavaMajor: number
  activeJavaMajor: number | null
  isAutoJava: boolean
  recommendedJavaPath: string | null
  recommendedJavaLabel: string | null
  javaOk: boolean
  recommendedMemoryMb: number
  activeMemoryMb: number
  systemMemoryMb: number
  memoryOk: boolean
  profileOk: boolean
  allReady: boolean
}

interface PreflightCardProps {
  packName: string
  minecraftVersion: string
  activeProfileName: string | null
  preflight: PackPreflightStatus
  onFixJava: () => void
  onFixMemory: () => void
  onFixAll: () => void
  onSelectProfile: () => void
}

export function PreflightCard({
  packName,
  minecraftVersion,
  activeProfileName,
  preflight,
  onFixJava,
  onFixMemory,
  onFixAll,
  onSelectProfile
}: PreflightCardProps) {
  if (preflight.allReady) {
    return (
      <section
        aria-label="Готовность к запуску"
        className="px-4 py-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] flex flex-wrap items-center justify-between gap-2 text-xs"
      >
        <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-medium">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>Всё готово к запуску</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-400 font-mono-tabular">
          <span>
            {preflight.isAutoJava
              ? `Java ${preflight.requiredJavaMajor} (авто)`
              : `Java ${preflight.activeJavaMajor ?? preflight.requiredJavaMajor}`}
          </span>
          <span aria-hidden="true">·</span>
          <span>ОЗУ {formatMemoryGb(preflight.activeMemoryMb)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-sans">Профиль {activeProfileName}</span>
        </div>
      </section>
    )
  }

  const fixableSystemIssues = (!preflight.javaOk ? 1 : 0) + (!preflight.memoryOk ? 1 : 0)

  const javaTooltip = preflight.recommendedJavaPath
    ? `Minecraft ${minecraftVersion} требует Java ${preflight.requiredJavaMajor} — на вашем ПК найдена ${preflight.recommendedJavaLabel ?? `Java ${preflight.requiredJavaMajor}`}. Параметр применится только к «${packName}», другие сборки не затронутся.`
    : `Minecraft ${minecraftVersion} требует Java ${preflight.requiredJavaMajor}. Переключим сборку «${packName}» на автоматический выбор — AbiLauncher сам подготовит совместимую Java перед запуском.`

  const memoryTooltip = `Для комфортной работы «${packName}» рекомендуется ${formatMemoryGb(preflight.recommendedMemoryMb)} из ${formatMemoryGb(preflight.systemMemoryMb)} ОЗУ вашего ПК — это предотвратит фризы и вылеты OutOfMemoryError, сохранив безопасный запас для системы.`

  const fixAllTooltip = `Применит сразу два параметра только для «${packName}»: ${preflight.recommendedJavaLabel ?? `автоматическую Java ${preflight.requiredJavaMajor}`} под MC ${minecraftVersion} и ${formatMemoryGb(preflight.recommendedMemoryMb)} из ${formatMemoryGb(preflight.systemMemoryMb)} ОЗУ вашей системы.`

  return (
    <section
      aria-label="Проверка перед запуском"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0e1521]"
    >
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100">
              Перед запуском «{packName}» лучше поправить параметры
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Изменения применятся только к этой сборке — остальные сборки не затронутся.
            </p>
          </div>
        </div>

        {fixableSystemIssues > 1 && (
          <Tooltip content={fixAllTooltip} placement="bottom" align="right">
            <button
              type="button"
              onClick={onFixAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap shrink-0"
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>Исправить всё</span>
            </button>
          </Tooltip>
        )}
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
        {/* Java check */}
        <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <Cpu
              className={`w-4 h-4 shrink-0 ${
                preflight.javaOk
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            />
            <div className="min-w-0">
              <span className="font-semibold text-slate-900 dark:text-slate-100">Java: </span>
              {preflight.javaOk ? (
                <span className="text-slate-600 dark:text-slate-400">
                  {preflight.isAutoJava
                    ? `Автоматический выбор Java ${preflight.requiredJavaMajor} (для MC ${minecraftVersion})`
                    : `Подходит Java ${preflight.activeJavaMajor} (для MC ${minecraftVersion})`}
                </span>
              ) : (
                <span className="text-slate-700 dark:text-slate-300">
                  Для MC {minecraftVersion} нужна{' '}
                  <strong className="font-semibold text-slate-900 dark:text-white">
                    Java {preflight.requiredJavaMajor}
                  </strong>
                  , сейчас выбрана Java {preflight.activeJavaMajor ?? '?'}
                </span>
              )}
            </div>
          </div>

          {preflight.javaOk ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium whitespace-nowrap shrink-0">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Подходит
            </span>
          ) : (
            <Tooltip content={javaTooltip} placement="top" align="right">
              <button
                type="button"
                onClick={onFixJava}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-600/40 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-800 dark:text-emerald-300 transition-colors whitespace-nowrap shrink-0"
              >
                {preflight.recommendedJavaPath
                  ? `Выбрать Java ${preflight.requiredJavaMajor}`
                  : `Авто-Java ${preflight.requiredJavaMajor}`}
              </button>
            </Tooltip>
          )}
        </div>

        {/* Memory check */}
        <div className="px-4 py-2.5 space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <MemoryStick
                className={`w-4 h-4 shrink-0 ${
                  preflight.memoryOk
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              />
              <div className="min-w-0">
                <span className="font-semibold text-slate-900 dark:text-slate-100">Память ОЗУ: </span>
                {preflight.memoryOk ? (
                  <span className="text-slate-600 dark:text-slate-400 font-mono-tabular">
                    Выделено {formatMemoryGb(preflight.activeMemoryMb)} (рекомендуется{' '}
                    {formatMemoryGb(preflight.recommendedMemoryMb)})
                  </span>
                ) : (
                  <span className="text-slate-700 dark:text-slate-300">
                    Рекомендуется{' '}
                    <strong className="font-mono-tabular font-semibold text-slate-900 dark:text-white">
                      {formatMemoryGb(preflight.recommendedMemoryMb)}
                    </strong>
                    , сейчас выделено{' '}
                    <span className="font-mono-tabular">
                      {formatMemoryGb(preflight.activeMemoryMb)}
                    </span>
                  </span>
                )}
              </div>
            </div>

            {preflight.memoryOk ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium whitespace-nowrap shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Достаточно
              </span>
            ) : (
              <Tooltip content={memoryTooltip} placement="top" align="right">
                <button
                  type="button"
                  onClick={onFixMemory}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-600/40 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-800 dark:text-emerald-300 transition-colors whitespace-nowrap shrink-0"
                >
                  Выделить {formatMemoryGb(preflight.recommendedMemoryMb)}
                </button>
              </Tooltip>
            )}
          </div>

          <div className="pl-6.5">
            <MemoryAllocationBar
              compact
              activeMemoryMb={preflight.activeMemoryMb}
              recommendedMemoryMb={preflight.recommendedMemoryMb}
              systemMemoryMb={preflight.systemMemoryMb}
            />
          </div>
        </div>

        {/* Profile check */}
        {!preflight.profileOk && (
          <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <User className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-slate-700 dark:text-slate-300">
                <strong className="font-semibold text-slate-900 dark:text-white">Профиль: </strong>
                Не выбран никнейм для запуска игры
              </span>
            </div>
            <button
              type="button"
              onClick={onSelectProfile}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 dark:text-amber-300 transition-colors whitespace-nowrap shrink-0"
            >
              Выбрать профиль
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
