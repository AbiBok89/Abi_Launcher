import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, realpath, rename, rm, statfs, unlink, writeFile, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkRelativePath } from '@shared/paths'
import { LauncherError } from './errors'

/** Безопасно соединяет корень сборки и относительный путь из манифеста. */
export function safeJoin(root: string, rel: string): string {
  const err = checkRelativePath(rel)
  if (err) throw new LauncherError('manifest-invalid', 'Небезопасный путь', `Путь «${rel}» отклонён: ${err}.`)
  const base = resolve(root)
  const target = resolve(base, ...rel.split('/'))
  if (!isInside(base, target)) {
    throw new LauncherError('manifest-invalid', 'Небезопасный путь', `Путь «${rel}» выходит за пределы папки сборки.`)
  }
  return target
}

export function isInside(base: string, target: string): boolean {
  const r = relative(base, target)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('..')
}

/**
 * Проверяет, что реальный путь существующих родительских каталогов не уводит
 * за пределы корня (защита от символических ссылок и junction внутри сборки).
 */
export async function assertRealInside(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root)
  let probe = dirname(target)
  // ищем ближайший существующий родитель
  for (;;) {
    try {
      await lstat(probe)
      break
    } catch {
      const up = dirname(probe)
      if (up === probe) return
      probe = up
    }
  }
  const real = await realpath(probe)
  if (real !== realRoot && !isInside(realRoot, real)) {
    throw new LauncherError('filesystem', 'Небезопасная ссылка', `Каталог ${probe} указывает за пределы папки сборки.`, 'Удалите символическую ссылку или junction из папки сборки.')
  }
  try {
    const st = await lstat(target)
    if (st.isSymbolicLink()) {
      throw new LauncherError('filesystem', 'Небезопасная ссылка', `Файл ${target} является символической ссылкой.`, 'Удалите ссылку и повторите.')
    }
  } catch (e) {
    if (e instanceof LauncherError) throw e
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true })
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Атомарная запись JSON: временный файл + fsync + rename. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(JSON.stringify(data, null, 2), 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await renameWithRetry(tmp, path)
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** rename с повторами: на Windows антивирус может кратковременно держать файл. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < 6; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        await copyFile(from, to)
        await unlink(from)
        return
      }
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 100 * (i + 1)))
    }
  }
  throw lastErr
}

export async function freeBytes(p: string): Promise<number | null> {
  let probe = resolve(p)
  for (;;) {
    try {
      const s = await statfs(probe)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      const up = dirname(probe)
      if (up === probe) return null
      probe = up
    }
  }
}

export async function assertFreeSpace(dir: string, needed: number): Promise<void> {
  const free = await freeBytes(dir)
  const margin = 256 * 1024 * 1024
  if (free !== null && free < needed + margin) {
    throw new LauncherError(
      'disk-space',
      'Недостаточно места на диске',
      `Нужно примерно ${formatBytes(needed + margin)}, свободно ${formatBytes(free)}.`,
      'Освободите место или выберите другую папку установки в настройках.'
    )
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** Проверка, что в папку можно писать. */
export async function checkWritable(dir: string): Promise<boolean> {
  try {
    await ensureDir(dir)
    const probe = join(dir, `.abilauncher-write-test-${process.pid}`)
    await writeFile(probe, 'ok')
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

export async function removeQuiet(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true }).catch(() => undefined)
}
