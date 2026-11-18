import { useState } from 'react'
import type { ConflictChoice, ConflictView } from '@shared/types'
import { IconAlert, IconCancel, IconCheck, IconShield } from './Icons'

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
          <h3 className="row" style={{ margin: '0 0 8px', gap: 8 }}>
            <IconAlert size={18} />
            <span>Конфликт изменённых файлов — {packName}</span>
          </h3>
          <p className="muted" style={{ margin: 0 }}>
            Обнаружены файлы сборки, которые отличаются от версии в манифесте. Перед заменой или удалением
            лаунчер автоматически сохранит вашу копию в <span className="mono">.abilauncher/backups</span>.
          </p>
        </div>

        <div className="stack-sm" style={{ maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
          {conflicts.map((c) => {
            const val = choices[c.path] ?? 'replace'
            return (
              <div key={c.path} className="card-flat stack-sm">
                <div className="row-between">
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {c.path}
                  </span>
                  <span className={`badge ${c.canKeep ? 'badge-info' : 'badge-warn'}`}>
                    {c.canKeep ? <IconShield size={12} /> : <IconAlert size={12} />}
                    <span>{c.canKeep ? 'Необязательный' : 'Обязательный файл'}</span>
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
            <IconCancel size={14} />
            <span>Отмена</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(choices)}>
            <IconCheck size={14} />
            <span>{actionLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
