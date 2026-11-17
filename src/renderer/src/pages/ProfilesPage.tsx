import { useState } from 'react'
import type { ProfilesState } from '@shared/types'

interface ProfilesPageProps {
  profiles: ProfilesState
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSelect: (id: string) => Promise<void>
}

export function ProfilesPage(props: ProfilesPageProps) {
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await props.onCreate(newName.trim())
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async (id: string) => {
    if (!editName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await props.onRename(id, editName.trim())
      setEditingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="banner banner-info">
        <strong>О локальных профилях</strong>
        <div>
          Локальный профиль использует только никнейм (без входа в Microsoft) и подходит для одиночной игры
          и серверов, допускающих вход без проверки аккаунта. Он не предоставляет доступ к серверам,
          требующим проверенный лицензионный аккаунт Microsoft.
        </div>
      </div>

      <form onSubmit={handleCreate} className="card stack-sm">
        <h4 style={{ margin: 0 }}>Создать локальный профиль</h4>
        <div className="row">
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Никнейм (3–16 символов: A-Z, 0-9, _)"
            maxLength={16}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Создать профиль
          </button>
        </div>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      </form>

      <div className="card stack">
        <h4 style={{ margin: 0 }}>Сохранённые профили</h4>
        {props.profiles.profiles.length === 0 ? (
          <div className="muted">Профилей пока нет. Создайте первый профиль выше, чтобы запустить игру.</div>
        ) : (
          <div className="stack-sm">
            {props.profiles.profiles.map((p) => {
              const active = props.profiles.selectedId === p.id
              const isEditing = editingId === p.id
              return (
                <div key={p.id} className="card-flat row-between">
                  <div className="stack-sm" style={{ gap: 2 }}>
                    {isEditing ? (
                      <div className="row">
                        <input
                          className="input"
                          style={{ width: 220 }}
                          maxLength={16}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          onClick={() => void handleRename(p.id)}
                        >
                          Сохранить
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditingId(null)}
                        >
                          Отмена
                        </button>
                      </div>
                    ) : (
                      <div className="row">
                        <strong style={{ fontSize: 15 }}>{p.name}</strong>
                        {active && <span className="badge badge-ok">Активный</span>}
                      </div>
                    )}
                    <div className="subtle mono">Offline UUID: {p.uuid}</div>
                  </div>
                  {!isEditing && (
                    <div className="row">
                      {!active && (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          onClick={() => void props.onSelect(p.id)}
                        >
                          Выбрать
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(p.id)
                          setEditName(p.name)
                          setError(null)
                        }}
                      >
                        Переименовать
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => void props.onDelete(p.id)}
                      >
                        Удалить
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
