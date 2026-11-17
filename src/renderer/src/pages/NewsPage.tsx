import { useMemo, useState } from 'react'
import type { NewsResult, PackView } from '@shared/types'
import { formatDateRu } from '../utils/format'

interface NewsPageProps {
  packs: PackView[]
  news: NewsResult | null
  loading: boolean
  onReload: () => void
  onSelectPack: (packKey: string) => void
}

export function NewsPage(props: NewsPageProps) {
  const [filterKey, setFilterKey] = useState<string>('all')

  const filteredItems = useMemo(() => {
    const items = props.news?.items ?? []
    if (filterKey === 'all') return items
    return items.filter((i) => i.packKey === filterKey)
  }, [props.news, filterKey])

  return (
    <div className="stack">
      <div className="row-between">
        <div className="row">
          <select
            className="select"
            style={{ width: 260 }}
            value={filterKey}
            onChange={(e) => setFilterKey(e.target.value)}
          >
            <option value="all">Все сборки</option>
            {props.packs.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={props.loading}
            onClick={props.onReload}
          >
            {props.loading ? 'Загрузка…' : 'Обновить новости'}
          </button>
        </div>
        <span className="subtle">
          Недоступность новостей не блокирует запуск сборок
        </span>
      </div>

      {props.news && props.news.errors.length > 0 && (
        <div className="banner banner-warn">
          <strong>Не удалось загрузить часть новостей:</strong>
          {props.news.errors.map((e, i) => (
            <div key={i} className="subtle">
              <span className="mono">{e.repo}</span>: {e.message}
            </div>
          ))}
        </div>
      )}

      {filteredItems.length === 0 ? (
        <div className="card muted">
          {props.loading ? 'Загрузка новостей из GitHub…' : 'Новостей пока нет.'}
        </div>
      ) : (
        <div className="stack-sm">
          {filteredItems.map((item) => (
            <article key={item.id} className="card stack-sm">
              <div className="row-between">
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => props.onSelectPack(item.packKey)}
                  >
                    {item.packName}
                  </button>
                  {item.packVersion && (
                    <span className="badge badge-info">{item.packVersion}</span>
                  )}
                </div>
                <span className="subtle">{formatDateRu(item.date)}</span>
              </div>
              <h4 style={{ margin: 0, fontSize: 16 }}>{item.title}</h4>
              {item.body && (
                <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{item.body}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
