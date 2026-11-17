import type { PackView, ProgressEvent } from '@shared/types'
import { STAGE_LABELS, STATUS_LABELS, formatBytes, formatLoader, formatSpeed } from '../utils/format'

interface DownloadsPageProps {
  packs: PackView[]
  progressByPack: Record<string, ProgressEvent>
  onCheckPack: (key: string) => Promise<void>
  onInstallPack: (key: string) => Promise<boolean>
  onPlayPack: (key: string) => Promise<boolean>
  onCancelOp: (key: string) => void
  onOpenPackPage: (key: string) => void
}

export function DownloadsPage(props: DownloadsPageProps) {
  const activeList = Object.values(props.progressByPack)
  const packMap = new Map(props.packs.map((p) => [p.key, p]))

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Активные загрузки и проверки</h3>
          <span className="subtle">
            Загрузки выполняются во временную папку и проверяются по SHA-256 до применения
          </span>
        </div>

        {activeList.length === 0 ? (
          <div className="muted">Сейчас нет активных операций.</div>
        ) : (
          <div className="stack-sm">
            {activeList.map((prog) => {
              const pack = packMap.get(prog.packKey)
              const pct =
                prog.bytesTotal > 0
                  ? Math.min(100, Math.round((prog.bytesDone / prog.bytesTotal) * 100))
                  : 0
              return (
                <div key={prog.packKey} className="card-flat stack-sm">
                  <div className="row-between">
                    <strong>{pack?.name ?? prog.packKey}</strong>
                    <div className="row">
                      <span className="badge badge-info">{STAGE_LABELS[prog.stage]}</span>
                      {prog.cancellable && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => props.onCancelOp(prog.packKey)}
                        >
                          Отменить
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${prog.bytesTotal <= 0 ? 'indeterminate' : ''}`}
                      style={prog.bytesTotal > 0 ? { width: `${pct}%` } : undefined}
                    />
                  </div>
                  <div className="row-between subtle">
                    <span>{prog.label}</span>
                    <span>
                      {prog.bytesTotal > 0
                        ? `${pct}% · ${formatBytes(prog.bytesDone)} / ${formatBytes(prog.bytesTotal)} · ${formatSpeed(prog.speed)}`
                        : 'Обработка…'}
                      {prog.filesTotal > 0 ? ` · Файлы: ${prog.filesDone}/${prog.filesTotal}` : ''}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Состояние сборок и обновлений</h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              for (const p of props.packs) {
                if (p.status !== 'checking' && p.status !== 'downloading' && p.status !== 'running') {
                  void props.onCheckPack(p.key)
                }
              }
            }}
          >
            Проверить все сборки
          </button>
        </div>

        {props.packs.length === 0 ? (
          <div className="muted">Список сборок пуст.</div>
        ) : (
          <div className="stack-sm">
            {props.packs.map((pack) => {
              const badge = STATUS_LABELS[pack.status]
              const busy =
                pack.status === 'checking' ||
                pack.status === 'downloading' ||
                pack.status === 'launching' ||
                pack.status === 'running'
              return (
                <div key={pack.key} className="card-flat row-between">
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <div className="row">
                      <strong>{pack.name}</strong>
                      <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
                    </div>
                    <div className="subtle">
                      MC {pack.minecraft} · {formatLoader(pack.loader)} · Установлена:{' '}
                      {pack.installedVersion ?? 'нет'} · На GitHub: {pack.version}
                    </div>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void props.onCheckPack(pack.key)}
                    >
                      Проверить
                    </button>
                    {!pack.installedVersion ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => void props.onInstallPack(pack.key)}
                      >
                        Установить
                      </button>
                    ) : pack.status === 'update-available' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => void props.onInstallPack(pack.key)}
                      >
                        Обновить
                      </button>
                    ) : pack.status === 'conflict' || pack.status === 'error' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-warn"
                        onClick={() => props.onOpenPackPage(pack.key)}
                      >
                        Открыть
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => void props.onPlayPack(pack.key)}
                      >
                        Играть
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
