import { checkRelativePath } from '@shared/paths'
import { LauncherError } from './errors'

export interface RepoRef {
  repo: string // owner/name
  branch: string
  path: string // путь к pack.json
}

const SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/**
 * Разбирает ввод пользователя: `owner/repo`, `https://github.com/owner/repo(.git)`,
 * `https://github.com/owner/repo/tree/branch`.
 */
export function parseRepoInput(input: string, branchOverride?: string): RepoRef {
  const raw = input.trim()
  let slug = raw
  let branch = branchOverride?.trim() || ''
  if (/^https?:\/\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      throw invalid()
    }
    if (u.hostname.toLowerCase() !== 'github.com' || u.protocol !== 'https:') throw invalid('Поддерживаются только репозитории на https://github.com')
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) throw invalid()
    slug = `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`
    if (!branch && parts[2] === 'tree' && parts[3]) branch = parts.slice(3).join('/')
  } else {
    slug = raw.replace(/\.git$/i, '')
  }
  if (!SLUG.test(slug) || slug.includes('..')) throw invalid()
  branch = branch || 'main'
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..')) throw invalid('Некорректное имя ветки')
  return { repo: slug, branch, path: 'ForLauncher/pack.json' }
}

function invalid(msg = 'Укажите репозиторий в виде owner/repo или ссылку https://github.com/owner/repo'): LauncherError {
  return new LauncherError('manifest-invalid', 'Некорректный адрес репозитория', msg)
}

export function rawUrl(ref: { repo: string; branch: string }, path: string): string {
  const err = checkRelativePath(path)
  if (err) throw new LauncherError('manifest-invalid', 'Небезопасный путь', `Путь «${path}»: ${err}`)
  const encPath = path.split('/').map(encodeURIComponent).join('/')
  const encBranch = ref.branch.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${ref.repo}/${encBranch}/${encPath}`
}

/** Преобразует ссылку на файл репозитория на github.com (blob) в raw-ссылку. */
export function normalizeCatalogUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  const u = new URL(s)
  if (u.protocol !== 'https:') throw invalid('Ссылка на каталог должна начинаться с https://')
  if (u.hostname === 'github.com') {
    const parts = u.pathname.split('/').filter(Boolean)
    // owner/repo/blob/branch/path...
    if (parts.length >= 5 && parts[2] === 'blob') {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`
    }
  }
  if (u.hostname !== 'raw.githubusercontent.com' && u.hostname !== 'github.com') {
    throw invalid('Каталог должен находиться на GitHub (raw.githubusercontent.com)')
  }
  return u.toString()
}
