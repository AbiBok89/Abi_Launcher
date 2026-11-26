import { useEffect, useRef, useState } from 'react'
import { ChevronUp, LogIn, LogOut, Newspaper, Palette } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { AuthSession } from '@shared/types'

interface AuthAccountCardProps {
  session: AuthSession | null
  siteUrl: string
  onOpenLogin: () => void
  onLogout: () => Promise<void>
  onOpenSitePage: (pagePath: string) => void
}

export function AuthAccountCard({
  session,
  siteUrl,
  onOpenLogin,
  onLogout,
  onOpenSitePage
}: AuthAccountCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setImgFailed(false)
  }, [session?.username, siteUrl])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  if (!session) {
    return (
      <button
        type="button"
        onClick={onOpenLogin}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-amber-500/60 bg-amber-500/10 hover:bg-amber-500/15 text-amber-800 dark:text-amber-300 text-left transition-colors"
      >
        <div className="w-7 h-7 rounded-md bg-amber-500/20 flex items-center justify-center shrink-0">
          <LogIn className="w-3.5 h-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold truncate leading-tight">Войти в аккаунт</div>
          <div className="text-[11px] opacity-80 truncate leading-tight mt-0.5">
            Требуется авторизация
          </div>
        </div>
      </button>
    )
  }

  const avatarUrl = `${siteUrl.replace(/\/+$/, '')}/api/avatar/${encodeURIComponent(
    session.username
  )}?size=64`

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-50 dark:bg-[#121b2a] hover:bg-slate-100 dark:hover:bg-[#182336] text-slate-900 dark:text-slate-100 text-left transition-colors"
        aria-expanded={menuOpen}
      >
        <div className="w-7 h-7 rounded-md overflow-hidden border border-slate-300 dark:border-slate-700 bg-emerald-600/15 flex items-center justify-center shrink-0 text-xs font-bold text-emerald-700 dark:text-emerald-400">
          {!imgFailed ? (
            <img
              src={avatarUrl}
              alt={session.username}
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            session.username[0].toUpperCase()
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold truncate leading-tight">{session.username}</div>
          <div className="text-[11px] text-emerald-700 dark:text-emerald-400 truncate font-mono-tabular leading-tight mt-0.5">
            Yggdrasil · {session.uuid.slice(0, 8)}
          </div>
        </div>
        <ChevronUp
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-150 ${
            menuOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1724] shadow-2xl overflow-hidden z-50 p-1.5 space-y-1 text-xs"
          >
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onOpenSitePage('/cabinet')
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <Palette className="w-4 h-4 text-emerald-500" />
              <span>Сменить скин / ЛК</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onOpenSitePage('/news')
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <Newspaper className="w-4 h-4 text-emerald-500" />
              <span>Новости сборок</span>
            </button>

            <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

            <button
              type="button"
              onClick={async () => {
                setMenuOpen(false)
                await onLogout()
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>Выйти из аккаунта</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
