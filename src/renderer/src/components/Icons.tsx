import type { PackStatus } from '@shared/types'

interface IconProps {
  size?: number
  className?: string
}

const baseProps = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.85,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  'aria-hidden': true as const
})

export function AbiLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="abiLogoGrad" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <path
        d="M16 2.5L28 9.25V22.75L16 29.5L4 22.75V9.25L16 2.5Z"
        fill="url(#abiLogoGrad)"
      />
      <path d="M16 15.8L27.2 9.7" stroke="rgba(255,255,255,0.65)" strokeWidth="1.6" />
      <path d="M16 15.8L4.8 9.7" stroke="rgba(255,255,255,0.65)" strokeWidth="1.6" />
      <path d="M16 15.8V28.7" stroke="rgba(255,255,255,0.65)" strokeWidth="1.6" />
      <path d="M16 8.5L21 18.5H11L16 8.5Z" fill="rgba(8,14,22,0.72)" />
    </svg>
  )
}

export function PlayerAvatar({ name, size = 34 }: { name: string | null; size?: number }) {
  const clean = (name ?? '?').trim()
  let hash = 0
  for (let i = 0; i < clean.length; i++) {
    hash = (hash * 31 + clean.charCodeAt(i)) >>> 0
  }
  const palettes = [
    ['#10b981', '#0ea5e9'],
    ['#3b82f6', '#8b5cf6'],
    ['#f59e0b', '#ef4444'],
    ['#06b6d4', '#14b8a6'],
    ['#ec4899', '#8b5cf6']
  ]
  const [c1, c2] = palettes[hash % palettes.length]
  const initial = (clean[0] ?? '?').toUpperCase()
  return (
    <div
      className="player-avatar"
      style={{
        width: size,
        height: size,
        background: name ? `linear-gradient(135deg, ${c1}, ${c2})` : 'var(--bg-hover)',
        color: name ? '#ffffff' : 'var(--text-subtle)',
        fontSize: Math.round(size * 0.44)
      }}
    >
      {initial}
    </div>
  )
}

export function IconCatalog({ size = 18, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="8" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </svg>
  )
}

export function IconDownloads({ size = 18, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

export function IconServers({ size = 18, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <circle cx="7" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
      <path d="M11 7.5h6" />
      <path d="M11 16.5h6" />
    </svg>
  )
}

export function IconNews({ size = 18, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M4 5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z" />
      <path d="M19 9h1a2 2 0 0 1 2 2v6a3 3 0 0 1-3 3" />
      <path d="M8 9h7" />
      <path d="M8 13h7" />
      <path d="M8 17h4" />
    </svg>
  )
}

export function IconProfiles({ size = 18, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  )
}

export function IconSettings({ size = 18, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

export function IconPlay({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)} fill="currentColor" stroke="none">
      <path d="M6.5 4.8c0-.8.88-1.28 1.56-.86l11.2 7.2a1 1 0 0 1 0 1.72l-11.2 7.2c-.68.42-1.56-.06-1.56-.86V4.8Z" />
    </svg>
  )
}

export function IconRefresh({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

export function IconCheck({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function IconAlert({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="m10.29 3.86-8.4 14.54A1.8 1.8 0 0 0 3.45 21h17.1a1.8 1.8 0 0 0 1.56-2.6L13.71 3.86a1.8 1.8 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <circle cx="12" cy="16.8" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconError({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  )
}

export function IconFolder({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2.5h7A2.5 2.5 0 0 1 21 9v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18V6.5Z" />
    </svg>
  )
}

export function IconCopy({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function IconPlus({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export function IconTrash({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    </svg>
  )
}

export function IconEdit({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
    </svg>
  )
}

export function IconCancel({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconSun({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
}

export function IconMoon({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  )
}

export function IconMonitor({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  )
}

export function IconShield({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M12 2 4 5v6c0 5.25 3.4 10 8 11 4.6-1 8-5.75 8-11V5l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function IconTerminal({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M12 15h5" />
    </svg>
  )
}

export function IconCpu({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  )
}

export function IconWifiOff({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M2 2 22 22" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 13a10 10 0 0 1 5.17-2.63" />
      <path d="M16.72 11.06A10 10 0 0 1 19 13" />
      <circle cx="12" cy="20" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconChevronRight({ size = 15, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function IconMinimize({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3 8.5h10" />
    </svg>
  )
}

export function IconMaximize({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.2" />
    </svg>
  )
}

export function IconRestore({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2.5" y="5" width="8.5" height="8.5" rx="1" />
      <path d="M5 5V3.5A1 1 0 0 1 6 2.5h6.5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H11" />
    </svg>
  )
}

export function IconClose({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M3.5 3.5 12.5 12.5" />
      <path d="M12.5 3.5 3.5 12.5" />
    </svg>
  )
}

export function IconCamera({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  )
}

export function IconPackage({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="M3.29 7 12 12l8.71-5" />
      <path d="M12 22V12" />
    </svg>
  )
}

export function IconExternalLink({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  )
}

export function StatusIcon({ status, size = 13 }: { status: PackStatus; size?: number }) {
  switch (status) {
    case 'ready':
      return <IconCheck size={size} />
    case 'running':
      return <span className="status-dot dot-live" />
    case 'launching':
    case 'checking':
    case 'downloading':
      return <IconRefresh size={size} className="spin-slow" />
    case 'update-available':
      return <IconDownloads size={size} />
    case 'conflict':
      return <IconAlert size={size} />
    case 'error':
      return <IconError size={size} />
    case 'not-installed':
      return <span className="status-dot dot-idle" />
  }
}
