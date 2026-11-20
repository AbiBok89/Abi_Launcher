interface PackCoverProps {
  src: string | null
  alt: string
  name: string
  className?: string
}

export function PackCover({ src, alt, name, className = '' }: PackCoverProps) {
  const initial = (name.trim()[0] ?? 'A').toUpperCase()

  if (src) {
    return (
      <div className={`overflow-hidden bg-slate-900 ${className}`}>
        <img src={src} alt={alt} className="w-full h-full object-cover" />
      </div>
    )
  }

  return (
    <div
      aria-label={alt}
      className={`overflow-hidden bg-gradient-to-br from-[#124e41] to-[#0f2942] flex items-center justify-center ${className}`}
    >
      <span className="font-display font-bold text-emerald-200/90 text-lg select-none">
        {initial}
      </span>
    </div>
  )
}
