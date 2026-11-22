import type { ReactNode } from 'react'

interface TooltipProps {
  content: string
  children: ReactNode
  placement?: 'top' | 'bottom'
  align?: 'left' | 'center' | 'right'
  compact?: boolean
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  align = 'right',
  compact = false
}: TooltipProps) {
  const positionClass = placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'

  const alignClass =
    align === 'left'
      ? 'left-0'
      : align === 'center'
        ? 'left-1/2 -translate-x-1/2'
        : 'right-0'

  const translateIdle = placement === 'top' ? 'translate-y-1' : '-translate-y-1'

  const sizeClass = compact
    ? 'w-max max-w-xs whitespace-nowrap px-2.5 py-1.5 text-center'
    : 'w-64 sm:w-72 px-3 py-2 text-left'

  return (
    <span className="relative inline-flex group/tip">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 ${sizeClass} rounded-lg text-[11px] leading-relaxed font-normal text-slate-100 bg-slate-900/95 dark:bg-[#172336] border border-slate-700/80 dark:border-slate-600/70 shadow-xl opacity-0 ${translateIdle} group-hover/tip:opacity-100 group-hover/tip:translate-y-0 group-focus-within/tip:opacity-100 group-focus-within/tip:translate-y-0 transition-[opacity,transform] duration-150 ${positionClass} ${alignClass}`}
      >
        {content}
      </span>
    </span>
  )
}
