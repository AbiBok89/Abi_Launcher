/**
 * Проверка относительных путей из удалённых манифестов.
 * Модуль чистый (без Node API), используется в main, core и в инструменте публикации.
 */

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

/** Служебная папка лаунчера внутри каждой сборки: манифест не может туда писать. */
export const LAUNCHER_META_DIR = '.abilauncher'

export const MAX_RELATIVE_PATH_LENGTH = 400

/**
 * Возвращает текст ошибки или null, если путь безопасен.
 * Допускаются только относительные пути с прямыми слешами без `..`, `.`,
 * абсолютных префиксов, букв дисков, NTFS-потоков и зарезервированных имён Windows.
 */
export function checkRelativePath(p: unknown): string | null {
  if (typeof p !== 'string') return 'путь должен быть строкой'
  if (p.length === 0) return 'пустой путь'
  if (p.length > MAX_RELATIVE_PATH_LENGTH) return 'слишком длинный путь'
  if (p.includes('\\')) return 'обратные слеши запрещены'
  if (p.startsWith('/')) return 'абсолютный путь запрещён'
  if (/^[a-zA-Z]:/.test(p)) return 'буква диска запрещена'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'управляющие символы запрещены'
  if (/[<>:"|?*]/.test(p)) return 'недопустимые символы в пути'
  const segments = p.split('/')
  for (const seg of segments) {
    if (seg === '') return 'пустой сегмент пути'
    if (seg === '.' || seg === '..') return 'переход по каталогам запрещён'
    if (seg.endsWith('.') || seg.endsWith(' ')) return 'сегмент не может оканчиваться точкой или пробелом'
    const base = seg.split('.')[0].toLowerCase()
    if (WINDOWS_RESERVED.has(base)) return `зарезервированное имя «${seg}»`
  }
  if (segments[0].toLowerCase() === LAUNCHER_META_DIR) return 'служебная папка лаунчера защищена'
  return null
}

export function isSafeRelativePath(p: unknown): p is string {
  return checkRelativePath(p) === null
}

/** Ключ для поиска дубликатов на нечувствительных к регистру ФС (Windows). */
export function pathKey(p: string): string {
  return p.normalize('NFC').toLowerCase()
}

/** Простая glob-проверка: поддерживает `**`, `*` и `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` — любое количество каталогов, `**` в конце — всё
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$', 'i')
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path))
}
