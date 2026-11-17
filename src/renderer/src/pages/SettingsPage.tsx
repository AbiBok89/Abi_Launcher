import { useState } from 'react'
import type {
  AfterLaunch,
  AppInfo,
  JavaInfoView,
  LogEntry,
  Settings,
  ThemeSetting
} from '@shared/types'
import type { SystemTheme } from '../../../preload/api'

interface SettingsPageProps {
  appInfo: AppInfo | null
  settings: Settings
  systemTheme: SystemTheme
  javaList: JavaInfoView[]
  logs: LogEntry[]
  onUpdateSettings: (patch: Partial<Settings>) => Promise<void>
  onPickDirectory: () => Promise<void>
  onPickJava: () => Promise<string | null>
  onRefreshJava: () => Promise<void>
  onTestJava: (path: string) => Promise<JavaInfoView>
  onAddRepo: (repo: string, branch?: string) => Promise<void>
  onRemoveRepo: (repo: string) => Promise<void>
  onExportDiagnostics: () => Promise<string | null>
}

export function SettingsPage(props: SettingsPageProps) {
  const { settings, appInfo } = props
  const maxMem = appInfo?.totalMemoryMb ?? 16384

  const [catalogUrlInput, setCatalogUrlInput] = useState(settings.catalogUrl)
  const [memoryInput, setMemoryInput] = useState(settings.defaultMemoryMb ?? 4096)
  const [widthInput, setWidthInput] = useState(settings.resolution.width)
  const [heightInput, setHeightInput] = useState(settings.resolution.height)
  const [javaInput, setJavaInput] = useState(settings.javaPath ?? '')
  const [javaCheckInfo, setJavaCheckInfo] = useState<string | null>(null)
  const [newRepo, setNewRepo] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const runAction = async (fn: () => Promise<void>, okText?: string) => {
    setErrorMsg(null)
    setStatusMsg(null)
    try {
      await fn()
      if (okText) setStatusMsg(okText)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const filteredLogs = props.logs.filter((entry) => {
    if (logFilter === 'all') return true
    if (logFilter === 'info') return entry.level === 'info'
    if (logFilter === 'warn') return entry.level === 'warn'
    return entry.level === 'error'
  })

  return (
    <div className="stack">
      {statusMsg && <div className="banner banner-info">{statusMsg}</div>}
      {errorMsg && <div className="banner banner-error">{errorMsg}</div>}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Внешний вид</h3>
        <div className="row-between">
          <div>
            <div style={{ fontWeight: 600 }}>Тема оформления</div>
            <div className="subtle">
              Системная тема сейчас: {props.systemTheme === 'dark' ? 'Тёмная' : 'Светлая'}
            </div>
          </div>
          <div className="row">
            {(
              [
                ['system', 'Системная'],
                ['light', 'Светлая'],
                ['dark', 'Тёмная']
              ] as Array<[ThemeSetting, string]>
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`btn btn-sm ${settings.theme === val ? 'btn-primary' : ''}`}
                onClick={() => void runAction(() => props.onUpdateSettings({ theme: val }))}
              >
                {label}
              </button>
            ))}
            {settings.theme !== 'system' && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void runAction(() => props.onUpdateSettings({ theme: 'system' }))}
              >
                Сбросить к системной
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Папка установки и параметры игры</h3>

        <div className="stack-sm">
          <div style={{ fontWeight: 600 }}>Папка для сборок, Minecraft и Java</div>
          <div className="row">
            <input className="input mono" readOnly value={settings.installDir} style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={() => void runAction(() => props.onPickDirectory())}>
              Выбрать папку…
            </button>
            {appInfo && settings.installDir !== appInfo.defaultInstallDir && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void runAction(
                    () => props.onUpdateSettings({ installDir: appInfo.defaultInstallDir }),
                    'Папка установки сброшена по умолчанию.'
                  )
                }
              >
                По умолчанию
              </button>
            )}
          </div>
        </div>

        <div className="grid-2">
          <div className="card-flat stack-sm">
            <div className="row-between">
              <span style={{ fontWeight: 600 }}>Память ОЗУ по умолчанию</span>
              <span className="mono">{memoryInput} МБ</span>
            </div>
            <input
              type="range"
              min={1024}
              max={maxMem}
              step={512}
              value={memoryInput}
              onChange={(e) => setMemoryInput(Number(e.target.value))}
            />
            <div className="row">
              <input
                type="number"
                className="input"
                style={{ width: 120 }}
                min={1024}
                max={maxMem}
                step={256}
                value={memoryInput}
                onChange={(e) => setMemoryInput(Number(e.target.value))}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() =>
                  void runAction(
                    () => props.onUpdateSettings({ defaultMemoryMb: memoryInput }),
                    'Объём памяти сохранён.'
                  )
                }
              >
                Сохранить ОЗУ
              </button>
            </div>
            <div className="subtle">Доступно в системе: {maxMem} МБ.</div>
          </div>

          <div className="card-flat stack-sm">
            <span style={{ fontWeight: 600 }}>Разрешение окна игры</span>
            <div className="row">
              <input
                type="number"
                className="input"
                style={{ width: 100 }}
                min={640}
                max={7680}
                value={widthInput}
                onChange={(e) => setWidthInput(Number(e.target.value))}
              />
              <span>×</span>
              <input
                type="number"
                className="input"
                style={{ width: 100 }}
                min={480}
                max={4320}
                value={heightInput}
                onChange={(e) => setHeightInput(Number(e.target.value))}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() =>
                  void runAction(
                    () =>
                      props.onUpdateSettings({
                        resolution: { ...settings.resolution, width: widthInput, height: heightInput }
                      }),
                    'Разрешение окна сохранено.'
                  )
                }
              >
                Применить
              </button>
            </div>
            <div className="row">
              {[
                [1280, 720],
                [1600, 900],
                [1920, 1080]
              ].map(([w, h]) => (
                <button
                  key={`${w}x${h}`}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setWidthInput(w)
                    setHeightInput(h)
                    void runAction(() =>
                      props.onUpdateSettings({
                        resolution: { ...settings.resolution, width: w, height: h }
                      })
                    )
                  }}
                >
                  {w}×{h}
                </button>
              ))}
            </div>
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.resolution.fullscreen}
                onChange={(e) =>
                  void runAction(() =>
                    props.onUpdateSettings({
                      resolution: { ...settings.resolution, fullscreen: e.target.checked }
                    })
                  )
                }
              />
              <span>Запускать в полноэкранном режиме</span>
            </label>
          </div>
        </div>

        <div className="grid-2">
          <label className="stack-sm" style={{ gap: 4 }}>
            <span style={{ fontWeight: 600 }}>Поведение лаунчера после запуска игры</span>
            <select
              className="select"
              value={settings.afterLaunch}
              onChange={(e) =>
                void runAction(() =>
                  props.onUpdateSettings({ afterLaunch: e.target.value as AfterLaunch })
                )
              }
            >
              <option value="keep">Оставлять окно лаунчера открытым</option>
              <option value="minimize">Сворачивать лаунчер в панель задач</option>
              <option value="hide">Скрывать лаунчер до выхода из игры</option>
              <option value="close">Закрывать лаунчер после выхода из игры</option>
            </select>
          </label>

          <div className="stack-sm" style={{ justifyContent: 'center' }}>
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.fullVerifyOnLaunch}
                onChange={(e) =>
                  void runAction(() =>
                    props.onUpdateSettings({ fullVerifyOnLaunch: e.target.checked })
                  )
                }
              />
              <span>Проверять SHA-256 всех файлов перед каждым запуском</span>
            </label>
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.autoJoinServer}
                onChange={(e) =>
                  void runAction(() =>
                    props.onUpdateSettings({ autoJoinServer: e.target.checked })
                  )
                }
              />
              <span>Автоматически подключаться к серверу сборки (если поддерживается)</span>
            </label>
          </div>
        </div>
      </div>

      <div className="card stack">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Java Runtime</h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runAction(() => props.onRefreshJava())}
          >
            Найти установленную Java
          </button>
        </div>

        <div className="row">
          <input
            className="input mono"
            style={{ flex: 1 }}
            placeholder="Автоматически (лаунчер сам скачает совместимую Java)"
            value={javaInput}
            onChange={(e) => setJavaInput(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const picked = await props.onPickJava()
              if (picked) setJavaInput(picked)
            }}
          >
            Обзор…
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void runAction(async () => {
                if (!javaInput.trim()) {
                  await props.onUpdateSettings({ javaPath: null })
                  setJavaCheckInfo('Включён автоматический выбор и установка Java.')
                  return
                }
                const info = await props.onTestJava(javaInput.trim())
                await props.onUpdateSettings({ javaPath: info.path })
                setJavaInput(info.path)
                setJavaCheckInfo(`Проверена и выбрана Java ${info.majorVersion} (${info.version}).`)
              })
            }
          >
            Проверить и сохранить
          </button>
          {settings.javaPath && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                void runAction(async () => {
                  setJavaInput('')
                  await props.onUpdateSettings({ javaPath: null })
                  setJavaCheckInfo('Выбор Java сброшен на автоматический.')
                })
              }
            >
              Авто
            </button>
          )}
        </div>
        {javaCheckInfo && <div className="subtle">{javaCheckInfo}</div>}

        {props.javaList.length > 0 && (
          <div className="stack-sm">
            <div className="subtle">Обнаруженные версии Java:</div>
            {props.javaList.map((j) => (
              <div key={j.path} className="card-flat row-between">
                <div className="stack-sm" style={{ gap: 2 }}>
                  <div className="row">
                    <strong>Java {j.majorVersion}</strong>
                    <span className="subtle">({j.version})</span>
                    <span className="badge badge-neutral">
                      {j.managed ? 'Установлена AbiLauncher' : 'Системная'}
                    </span>
                  </div>
                  <div className="subtle mono">{j.path}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setJavaInput(j.path)
                    void runAction(
                      () => props.onUpdateSettings({ javaPath: j.path }),
                      `Выбрана Java ${j.majorVersion}.`
                    )
                  }}
                >
                  Выбрать
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Источники сборок GitHub</h3>
        <div className="stack-sm">
          <div style={{ fontWeight: 600 }}>Адрес официального каталога (catalog.json)</div>
          <div className="row">
            <input
              className="input mono"
              style={{ flex: 1 }}
              value={catalogUrlInput}
              onChange={(e) => setCatalogUrlInput(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void runAction(
                  () => props.onUpdateSettings({ catalogUrl: catalogUrlInput }),
                  'Адрес каталога обновлён.'
                )
              }
            >
              Сохранить
            </button>
          </div>
        </div>

        <div className="stack-sm">
          <div style={{ fontWeight: 600 }}>Дополнительные репозитории сборок</div>
          <div className="row">
            <input
              className="input"
              style={{ flex: 2 }}
              placeholder="owner/repo или ссылка GitHub"
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
            />
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="Ветка (main)"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={() =>
                void runAction(async () => {
                  if (!newRepo.trim()) return
                  await props.onAddRepo(newRepo.trim(), newBranch.trim() || undefined)
                  setNewRepo('')
                  setNewBranch('')
                }, 'Репозиторий добавлен.')
              }
            >
              Добавить
            </button>
          </div>
          {settings.customRepos.map((r) => (
            <div key={`${r.repo}:${r.branch}`} className="card-flat row-between">
              <span className="mono">
                {r.repo} ({r.branch}) — {r.path}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => void runAction(() => props.onRemoveRepo(r.repo))}
              >
                Удалить
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card stack">
        <div className="row-between">
          <div>
            <h3 style={{ margin: 0 }}>Диагностика и логи</h3>
            <div className="subtle">
              Экспорт удаляет домашний путь, имя пользователя ОС и возможные токены.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void runAction(async () => {
                const file = await props.onExportDiagnostics()
                if (file) setStatusMsg(`Диагностический отчёт сохранён: ${file}`)
              })
            }
          >
            Экспортировать отчёт
          </button>
        </div>

        <div className="row">
          {(
            [
              ['all', 'Все записи'],
              ['info', 'Инфо'],
              ['warn', 'Предупреждения'],
              ['error', 'Ошибки']
            ] as const
          ).map(([lvl, lbl]) => (
            <button
              key={lvl}
              type="button"
              className={`btn btn-sm ${logFilter === lvl ? 'btn-primary' : ''}`}
              onClick={() => setLogFilter(lvl)}
            >
              {lbl}
            </button>
          ))}
        </div>

        <div className="log-box">
          {filteredLogs.length === 0 ? (
            <div className="subtle">Записей пока нет.</div>
          ) : (
            filteredLogs.slice(-300).map((l, idx) => (
              <div
                key={idx}
                className={`log-line ${
                  l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : ''
                }`}
              >
                [{l.ts.slice(11, 19)}] [{l.level.toUpperCase()}] [{l.scope}] {l.message}
              </div>
            ))
          )}
        </div>

        <div className="banner banner-info subtle">
          <div>
            <strong>О проверке целостности:</strong> контрольные суммы SHA-256 подтверждают, что файлы
            скачались без повреждений и соответствуют манифесту, но не заменяют доверие к самому GitHub-репозиторию.
          </div>
          <div>
            <strong>Версия лаунчера:</strong> {appInfo?.version ?? '0.1.0'} · Обновление самого лаунчера
            отделено от сборок и запланировано как следующий этап развития.
          </div>
        </div>
      </div>
    </div>
  )
}
