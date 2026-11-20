import { useId } from 'react'

export function AbiLogo({ size = 24 }: { size?: number }) {
  const uid = useId()
  const bgGrad = `abi-bg-${uid}`
  const topFacet = `abi-top-${uid}`
  const accentGrad = `abi-accent-${uid}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id={bgGrad} x1="3" y1="2" x2="33" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0f2922" />
          <stop offset="100%" stopColor="#07131c" />
        </linearGradient>
        <linearGradient id={topFacet} x1="8" y1="5" x2="28" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
        <linearGradient id={accentGrad} x1="10" y1="9" x2="26" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="55%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>

      <rect
        x="1"
        y="1"
        width="34"
        height="34"
        rx="9"
        fill={`url(#${bgGrad})`}
        stroke="#10b981"
        strokeOpacity="0.45"
        strokeWidth="1.25"
      />
      <path
        d="M18 5.8L28.2 11.6L18 16.4L7.8 11.6L18 5.8Z"
        fill={`url(#${topFacet})`}
        fillOpacity="0.22"
      />
      <path
        d="M18 7.5L27.4 26.8H22.4L18 17.3L13.6 26.8H8.6L18 7.5Z"
        fill={`url(#${accentGrad})`}
      />
      <path d="M18 20.3L21.9 25.4H14.1L18 20.3Z" fill="#a7f3d0" />
    </svg>
  )
}
