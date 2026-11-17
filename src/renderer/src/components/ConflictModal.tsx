import { useState } from 'react'
import type { ConflictChoice, ConflictView } from '@shared/types'

interface ConflictModalProps {
  packName: string
  conflicts: ConflictView[]
  actionLabel: string
  onCancel: () => void
  onApply: (resolutions: Record<string, ConflictChoice>) => void
}

const KIND_LABELS: Record<ConflictView['kind'], string> = {
  modified: 'Изменён игроком',
  untracked: 'Уже есть на диске (не изменён лаунчером)',
  'obsolete-modified': 'Удалён в новой версии сборки, но изменён игроком'
}

export function ConflictModal({ packName, conflicts, actionLabel, onCancel, onApply }: ConflictModalProps) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>(() => {
    const init: Record<string, ConflictChoice> = {}
    for (const c of conflicts) init[c.path] = 'replace'
    return init
  })

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card stack">
        <div>
          <h3 style={{ margin: '0 0 6px' }}>Конфликт изменённых файлов — {packName}</h3>
          <p className="muted" style={{ margin: 0 }}>
            Обнаружены файлы сборки, которые отличаются от версии в манифесте. Перед заменой или удалением
            лаунчер автоматически сохранит вашу копию в <span className="mono">.abilauncher/backups</span>.
          </p>
        </div>

        <div className="stack-sm">
          {conflicts.map((c) => {
            const val = choices[c.path] ?? 'replace'
            return (
              <div key={c.path} className="card-flat stack-sm">
                <div className="row-between">
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {c.path}
                  </span>
                  <span className={`badge ${c.canKeep ? 'badge-info' : 'badge-warn'}`}>
                    {c.canKeep ? 'Необязательный' : 'Обязательный файл'}
                  </span>
                </div>
                <div className="subtle">{KIND_LABELS[c.kind]}</div>
                <div className="row">
                  <label className="row" style={{ cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name={`conflict-${c.path}`}
                      checked={val === 'replace'}
                      onChange={() => setChoices((prev) => ({ ...prev, [c.path]: 'replace' }))}
                    />
                    <span>
                      {c.kind === 'obsolete-modified'
                        ? 'Удалить с резервной копией'
                        : 'Заменить версией из сборки (с бэкапом)'}
                    </span>
                  </label>
                  {c.canKeep ? (
                    <label className="row" style={{ cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name={`conflict-${c.path}`}
                        checked={val === 'keep'}
                        onChange={() => setChoices((prev) => ({ ...prev, [c.path]: 'keep' }))}
                      />
                      <span>Оставить мою версию</span>
                    </label>
                  ) : (
                    <span className="subtle">
                      Обязательный файл нельзя пропустить: несовпадение блокирует запуск.
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(choices)}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
