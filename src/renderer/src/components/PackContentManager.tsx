import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  FolderOpen,
  Info,
  Loader2,
  Lock,
  Palette,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  PackAddonCategory,
  PackContentView,
  PackSubfolder,
  PackView
} from '@shared/types'
import { formatBytes, formatDateTimeRu } from '../utils/format'

type ContentSection = PackAddonCategory | 'integrity'

interface PackContentManagerProps {
  pack: PackView
  isBusy: boolean
  onCheckPack: () => Promise<void>
  onOpenFolder: (subfolder?: PackSubfolder) => void
  onToast: (message: string, tone?: 'info' | 'ok' | 'warn') => void
}

const CATEGORY_META: Record<
  PackAddonCategory,
  {
    label: string
    subfolder: PackSubfolder
    addLabel: string
    emptyHint: string
  }
> = {
  mod: {
    label: 'Моды',
    subfolder: 'mods',
    addLabel: 'Добавить мод (.jar)',
    emptyHint:
      'Пользовательских модов пока нет — можно добавить клиентский мод вроде мини-карты через кнопку выше.'
  },
  shader: {
    label: 'Шейдеры',
    subfolder: 'shaderpacks',
    addLabel: 'Добавить шейдер (.zip)',
    emptyHint: 'Шейдеры пока не добавлены. Добавьте архив шейдеров (.zip) с диска или откройте папку.'
  },
  resourcepack: {
    label: 'Ресурс-паки',
    subfolder: 'resourcepacks',
    addLabel: 'Добавить текстуры (.zip)',
    emptyHint: 'Дополнительных ресурс-паков пока нет.'
  }
}

export function PackContentManager({
  pack,
  isBusy,
  onCheckPack,
  onOpenFolder,
  onToast
}: PackContentManagerProps) {
  const [section, setSection] = useState<ContentSection>('mod')
  const [query, setQuery] = useState('')
  const [onlyUser, setOnlyUser] = useState(false)
  const [content, setContent] = useState<PackContentView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyFile, setBusyFile] = useState<string | null>(null)

  const loadContent = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.abi.listPackContent(pack.key)
      if (res.ok) {
        setContent(res.value)
      } else {
        onToast(res.error.message, 'warn')
      }
    } finally {
      setLoading(false)
    }
  }, [onToast, pack.key])

  useEffect(() => {
    void loadContent()
  }, [loadContent, pack.installedVersion, pack.status])

  const addons = content?.addons ?? []
  const backups = content?.backups ?? []

  const counts = useMemo(() => {
    let mod = 0
    let shader = 0
    let resourcepack = 0
    for (const a of addons) {
      if (a.category === 'mod') mod++
      else if (a.category === 'shader') shader++
      else resourcepack++
    }
    return { mod, shader, resourcepack }
  }, [addons])

  const filteredItems = useMemo(() => {
    if (section === 'integrity') return []
    const q = query.trim().toLowerCase()
    return addons.filter((item) => {
      if (item.category !== section) return false
      if (onlyUser && item.source !== 'user') return false
      if (q && !item.name.toLowerCase().includes(q) && !item.fileName.toLowerCase().includes(q)) {
        return false
      }
      return true
    })
  }, [addons, onlyUser, query, section])

  const userItems = filteredItems.filter((i) => i.source === 'user')
  const packItems = filteredItems.filter((i) => i.source === 'pack')

  const handleToggle = async (category: PackAddonCategory, fileName: string, displayName: string, currentlyEnabled: boolean) => {
    setBusyFile(fileName)
    try {
      const res = await window.abi.togglePackAddon(pack.key, category, fileName)
      if (res.ok) {
        setContent(res.value)
        onToast(`${displayName} ${currentlyEnabled ? 'отключён' : 'включён'}`, 'info')
      } else {
        onToast(res.error.message, 'warn')
      }
    } finally {
      setBusyFile(null)
    }
  }

  const handleDelete = async (category: PackAddonCategory, fileName: string, displayName: string) => {
    setBusyFile(fileName)
    try {
      const res = await window.abi.deletePackAddon(pack.key, category, fileName)
      if (res.ok) {
        setContent(res.value)
        onToast(`Удалён файл «${displayName}»`, 'info')
      } else {
        onToast(res.error.message, 'warn')
      }
    } finally {
      setBusyFile(null)
    }
  }

  const handleImport = async (category: PackAddonCategory) => {
    const res = await window.abi.importPackAddon(pack.key, category)
    if (res.ok) {
      if (res.value) {
        setContent(res.value)
        onToast('Файлы добавлены в сборку', 'ok')
      }
    } else {
      onToast(res.error.message, 'warn')
    }
  }

  return (
    <div className="space-y-5">
      {/* Category Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-200/75 dark:bg-slate-800/80"
          role="tablist"
          aria-label="Категории файлов сборки"
        >
          {(
            [
              ['mod', `Моды (${counts.mod})`, Puzzle],
              ['shader', `Шейдеры (${counts.shader})`, Sparkles],
              ['resourcepack', `Ресурс-паки (${counts.resourcepack})`, Palette],
              ['integrity', 'Целостность и бэкапы', ShieldCheck]
            ] as Array<[ContentSection, string, typeof Puzzle]>
          ).map(([id, label, Icon]) => {
            const active = section === id
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSection(id)}
                className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'text-slate-900 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="content-section-indicator"
                    transition={{ type: 'spring', stiffness: 520, damping: 38 }}
                    className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-xs"
                  />
                )}
                <Icon className="w-3.5 h-3.5 relative z-10" />
                <span className="relative z-10">{label}</span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadContent()}
            disabled={loading}
            title="Перечитать папку сборки"
            className="p-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {section !== 'integrity' && (
            <>
              <button
                type="button"
                onClick={() => onOpenFolder(CATEGORY_META[section].subfolder)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Папка</span>
              </button>
              <button
                type="button"
                onClick={() => void handleImport(section)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-[#042117] transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{CATEGORY_META[section].addLabel}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* SECTION BODY */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={section}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
        >
          {section !== 'integrity' && (
            <div className="space-y-4">
              {section === 'mod' && pack.server && (
                <div className="px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-[#0e1521] flex items-start gap-2.5 text-xs text-slate-600 dark:text-slate-400">
                  <Info className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
                  <span>
                    Моды из основы сборки защищены от отключения, чтобы вы всегда могли зайти на
                    сервер{' '}
                    <span className="font-mono-tabular text-slate-800 dark:text-slate-200">
                      {pack.server.host}
                    </span>
                    . Клиентские дополнения (мини-карта, интерфейс, шейдеры) можно свободно включать
                    и выключать.
                  </span>
                </div>
              )}

              {content && !content.instanceExists && (
                <div className="p-5 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-xs text-slate-500 dark:text-slate-400">
                  Сборка ещё не установлена на диск. После установки здесь появятся все установленные
                  моды, шейдеры и ресурс-паки.
                </div>
              )}

              {/* Search & Filter */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative flex-1 min-w-[220px] max-w-sm">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Поиск в разделе «${CATEGORY_META[section].label}»…`}
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0e1521] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>

                <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={onlyUser}
                    onChange={(e) => setOnlyUser(e.target.checked)}
                    className="accent-emerald-600 dark:accent-emerald-500"
                  />
                  <span>Только добавленные вами</span>
                </label>
              </div>

              {/* Group 1: User-added items */}
              <section className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Добавленные вами ({userItems.length})
                  </h3>
                  <span className="text-[11px] text-slate-400">
                    Сохраняются при обновлении сборки
                  </span>
                </div>

                {userItems.length === 0 ? (
                  <div className="p-5 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-xs text-slate-500 dark:text-slate-400">
                    {query
                      ? 'Ничего не найдено среди ваших файлов.'
                      : CATEGORY_META[section].emptyHint}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#0e1521]">
                    {userItems.map((item) => {
                      const rowBusy = busyFile === item.fileName
                      return (
                        <div
                          key={item.fileName}
                          className={`px-4 py-3 flex items-center justify-between gap-4 transition-opacity ${
                            item.enabled ? '' : 'opacity-65'
                          }`}
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
                                {item.name}
                              </span>
                              {item.sizeBytes > 0 && (
                                <span className="text-[11px] font-mono-tabular text-slate-500 dark:text-slate-400">
                                  {formatBytes(item.sizeBytes)}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono-tabular text-slate-400 dark:text-slate-500 truncate">
                              {item.fileName}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <button
                              type="button"
                              role="switch"
                              disabled={rowBusy}
                              aria-checked={item.enabled}
                              aria-label={`${item.enabled ? 'Отключить' : 'Включить'} ${item.name}`}
                              onClick={() =>
                                void handleToggle(item.category, item.fileName, item.name, item.enabled)
                              }
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                item.enabled
                                  ? 'bg-emerald-600 dark:bg-emerald-500'
                                  : 'bg-slate-300 dark:bg-slate-700'
                              }`}
                            >
                              <span
                                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                                  item.enabled ? 'translate-x-4.5' : 'translate-x-1'
                                }`}
                              />
                            </button>

                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() =>
                                void handleDelete(item.category, item.fileName, item.name)
                              }
                              title="Удалить файл"
                              aria-label={`Удалить ${item.name}`}
                              className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* Group 2: Protected Pack Base items */}
              {!onlyUser && (
                <section className="space-y-2 pt-1">
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                      Основа сборки ({packItems.length})
                    </h3>
                    <span className="text-[11px] text-slate-400">
                      Управляется манифестом · защищено
                    </span>
                  </div>

                  {packItems.length === 0 ? (
                    <div className="py-4 text-xs text-slate-500 dark:text-slate-400">
                      {query
                        ? 'Ничего не найдено в основе сборки.'
                        : `В папке сборки нет файлов манифеста для раздела «${CATEGORY_META[section].label}».`}
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white/75 dark:bg-[#0e1521]/80 max-h-80 overflow-y-auto">
                      {packItems.map((item) => (
                        <div
                          key={item.fileName}
                          className="px-4 py-2.5 flex items-center justify-between gap-4"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {item.name}
                              </span>
                              {item.sizeBytes > 0 && (
                                <span className="text-[11px] font-mono-tabular text-slate-500 dark:text-slate-400">
                                  {formatBytes(item.sizeBytes)}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono-tabular text-slate-400 dark:text-slate-500 truncate">
                              {item.fileName}
                            </div>
                          </div>
                          <span
                            title="Обязательный файл из манифеста сборки"
                            className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0"
                          >
                            <Lock className="w-3 h-3" />
                            <span>Из сборки</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* SECTION: INTEGRITY & BACKUPS */}
          {section === 'integrity' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    Целостность файлов и резервные копии
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Управляемые файлы отслеживаются в{' '}
                    <span className="font-mono-tabular">.abilauncher/state.json</span>. Ваши моды,
                    шейдеры и сохранения при проверке не удаляются.
                  </p>
                </div>

                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void onCheckPack()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                >
                  {isBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  )}
                  <span>Проверить целостность</span>
                </button>
              </div>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Archive className="w-3.5 h-3.5" />
                    <span>Резервные копии (.abilauncher/backups)</span>
                  </h3>
                  <button
                    type="button"
                    onClick={() => onOpenFolder('backups')}
                    className="text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                  >
                    Открыть папку бэкапов
                  </button>
                </div>

                {backups.length === 0 ? (
                  <div className="p-6 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-xs text-slate-500">
                    Резервных копий пока нет. Они создаются автоматически при замене изменённых
                    пользователем файлов во время обновления сборки.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#0e1521]">
                    {backups.map((bk) => (
                      <div
                        key={bk.name}
                        className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-mono-tabular font-medium text-slate-900 dark:text-slate-100 truncate">
                            {bk.name}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono-tabular">
                            {bk.modifiedAt ? formatDateTimeRu(bk.modifiedAt) : '—'} · файлов:{' '}
                            {bk.filesCount}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onOpenFolder('backups')}
                          className="text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline whitespace-nowrap shrink-0"
                        >
                          Открыть
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
