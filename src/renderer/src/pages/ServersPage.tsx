import { useState } from 'react'
import type { PackView, ServerStatus } from '@shared/types'
import { formatLoader, formatServerAddress } from '../utils/format'

interface ServersPageProps {
  packs: PackView[]
  serverStatuses: Record<string, ServerStatus>
  pinging: Record<string, boolean>
  onPingAll: () => void
  onPingOne: (host: string, port?: number) => void
  onJoinPlay: (packKey: string) => void
}

function serverKey(host: string, port?: number): string {
  return `${host}:${port ?? 25565}`
}

export function ServersPage(props: ServersPageProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const packsWithServers = props.packs.filter((p) => p.server !== null)

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr).catch(() => undefined)
    setCopied(addr)
    setTimeout(() => setCopied((cur) => (cur === addr ? null : cur)), 1800)
  }

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h3 style={{ margin: 0 }}>Игровые серверы</h3>
          <div className="subtle">
            Подключение при запуске поддерживается автоматически там, где это умеет версия Minecraft.
          </div>
        </div>
        <button type="button" className="btn" onClick={props.onPingAll}>
          Обновить все статусы
        </button>
      </div>

      {packsWithServers.length === 0 ? (
        <div className="card muted">В загруженном каталоге пока нет сборок со связанными серверами.</div>
      ) : (
        <div className="stack-sm">
          {packsWithServers.map((pack) => {
            const srv = pack.server!
            const key = serverKey(srv.host, srv.port)
            const addr = formatServerAddress(srv.host, srv.port)
            const st = props.serverStatuses[key]
            const busyPing = Boolean(props.pinging[key])
            const packBusy =
              pack.status === 'checking' ||
              pack.status === 'downloading' ||
              pack.status === 'launching' ||
              pack.status === 'running'

            return (
              <div key={pack.key} className="card stack-sm">
                <div className="row-between">
                  <div>
                    <div className="row">
                      <strong style={{ fontSize: 16 }}>{srv.name}</strong>
                      <span className="badge badge-neutral">{pack.name}</span>
                    </div>
                    <div className="subtle">
                      Minecraft {pack.minecraft} · {formatLoader(pack.loader)}
                    </div>
                  </div>
                  <div className="row">
                    {busyPing ? (
                      <span className="badge badge-info">Проверка…</span>
                    ) : st ? (
                      <span className={`badge ${st.online ? 'badge-ok' : 'badge-danger'}`}>
                        {st.online
                          ? `Онлайн · Игроки: ${st.playersOnline ?? '?'}/${st.playersMax ?? '?'}${st.latencyMs !== null ? ` · ${st.latencyMs} мс` : ''}`
                          : 'Офлайн'}
                      </span>
                    ) : (
                      <span className="badge badge-neutral">Статус неизвестен</span>
                    )}
                  </div>
                </div>

                {st?.motd && <div className="muted">{st.motd}</div>}
                {st && !st.online && st.error && <div className="subtle">{st.error}</div>}
                {st?.online && st.version && (
                  <div className="subtle">Версия сервера: {st.version}</div>
                )}

                <div className="row-between">
                  <div className="row">
                    <span className="mono">{addr}</span>
                    <button type="button" className="btn btn-sm" onClick={() => copyAddr(addr)}>
                      {copied === addr ? 'Скопировано' : 'Скопировать адрес'}
                    </button>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyPing}
                      onClick={() => props.onPingOne(srv.host, srv.port)}
                    >
                      Пинг
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={packBusy}
                      onClick={() => props.onJoinPlay(pack.key)}
                    >
                      Играть на сервере
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
