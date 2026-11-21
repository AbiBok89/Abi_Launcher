import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ChevronUp, Pencil, Plus, Trash2, User, UserPlus, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { Profile, ProfilesState } from '@shared/types'

interface ProfileSwitcherPopoverProps {
  profiles: ProfilesState
  activeProfile: Profile | null
  forceOpen?: boolean
  onForceOpenConsumed?: () => void
  onSelect: (id: string) => Promise<void>
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

export function ProfileSwitcherPopover({
  profiles,
  activeProfile,
  forceOpen,
  onForceOpenConsumed,
  onSelect,
  onCreate,
  onRename,
  onDelete
}: ProfileSwitcherPopoverProps) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (forceOpen) {
      setOpen(true)
      onForceOpenConsumed?.()
    }
  }, [forceOpen, onForceOpenConsumed])

  useEffect(() => {
    if (!open) return
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditingId(null)
        setError(null)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setEditingId(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(newName.trim())
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveRename = async (id: string) => {
    if (!editValue.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onRename(id, editValue.trim())
      setEditingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors ${
          !activeProfile
            ? 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300'
            : 'border-slate-200 dark:border-slate-700/80 bg-slate-50 dark:bg-[#121b2a] hover:bg-slate-100 dark:hover:bg-[#182336] text-slate-900 dark:text-slate-100'
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <div
          className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 text-xs font-bold ${
            activeProfile
              ? 'bg-emerald-600/15 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
          }`}
        >
          {activeProfile ? (
            activeProfile.name[0].toUpperCase()
          ) : (
            <UserPlus className="w-3.5 h-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold truncate leading-tight">
            {activeProfile ? activeProfile.name : 'Выбрать профиль'}
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate font-mono-tabular leading-tight mt-0.5">
            {activeProfile
              ? `offline · ${activeProfile.uuid.slice(0, 8)}`
              : 'Нужен никнейм для запуска'}
          </div>
        </div>
        <ChevronUp
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-label="Управление локальными профилями"
            className="absolute bottom-full left-0 mb-2 w-80 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0f1724] shadow-2xl overflow-hidden z-50 origin-bottom-left"
          >
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  Локальные профили
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Offline UUID · переключение без ухода со сборки
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="Закрыть список профилей"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
              {profiles.profiles.length === 0 ? (
                <div className="px-4 py-5 text-center text-xs text-slate-500 dark:text-slate-400">
                  <User className="w-5 h-5 mx-auto mb-1.5 opacity-60" />
                  Нет профилей. Создайте первый никнейм ниже.
                </div>
              ) : (
                profiles.profiles.map((prof) => {
                  const isSelected = prof.id === profiles.selectedId
                  const isEditing = editingId === prof.id
                  return (
                    <div
                      key={prof.id}
                      className={`px-3 py-2.5 flex items-center gap-2 transition-colors ${
                        isSelected
                          ? 'bg-emerald-500/[0.08] dark:bg-emerald-500/[0.11]'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-1.5 flex-1">
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleSaveRename(prof.id)
                              if (e.key === 'Escape') setEditingId(null)
                            }}
                            autoFocus
                            className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-emerald-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none"
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSaveRename(prof.id)}
                            className="p-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 rounded"
                            aria-label="Сохранить никнейм"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="p-1 text-slate-400 hover:text-slate-600 rounded"
                            aria-label="Отменить переименование"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              void onSelect(prof.id)
                              setOpen(false)
                            }}
                            className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                          >
                            <div className="w-6 h-6 rounded bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-[11px] font-bold text-slate-700 dark:text-slate-200 shrink-0">
                              {prof.name[0].toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {prof.name}
                              </div>
                              <div className="text-[10px] font-mono-tabular text-slate-500 dark:text-slate-400 truncate">
                                {prof.uuid}
                              </div>
                            </div>
                            {isSelected && (
                              <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(prof.id)
                              setEditValue(prof.name)
                              setError(null)
                            }}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded"
                            title="Переименовать"
                            aria-label={`Переименовать ${prof.name}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDelete(prof.id)}
                            className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded"
                            title="Удалить"
                            aria-label={`Удалить ${prof.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            <form
              onSubmit={(e) => void handleCreate(e)}
              className="p-3 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-800 space-y-2"
            >
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value)
                    if (error) setError(null)
                  }}
                  placeholder="Новый никнейм (3–16 симв.)"
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
                <button
                  type="submit"
                  disabled={busy || !newName.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Создать</span>
                </button>
              </div>
              {error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
