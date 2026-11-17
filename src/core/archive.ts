import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import yauzl from 'yauzl'
import { checkRelativePath } from '@shared/paths'
import { CancelledError, LauncherError, throwIfAborted } from './errors'
import { assertRealInside, isInside, renameWithRetry, safeJoin } from './fsutil'

export interface ZipExtractSpec {
  targetAbsPath: string
  expectedSize: number
  expectedSha256: string
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveOpen, rejectOpen) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) {
        rejectOpen(
          new LauncherError(
            'integrity',
            'Повреждённый архив',
            `Не удалось открыть ZIP-архив: ${err?.message ?? 'неизвестная ошибка'}.`
          )
        )
        return
      }
      resolveOpen(zip)
    })
  })
}

function isZipSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
  return unixMode === 0o120000
}

function validateZipEntryName(rawName: string): { clean: string; isDir: boolean } {
  const isDir = rawName.endsWith('/')
  const clean = isDir ? rawName.slice(0, -1) : rawName
  if (clean.length === 0 && isDir) return { clean: '', isDir: true }
  const err = checkRelativePath(clean)
  if (err) {
    throw new LauncherError(
      'manifest-invalid',
      'Небезопасный путь в архиве',
      `Архив содержит недопустимый путь «${rawName}»: ${err}.`
    )
  }
  return { clean, isDir }
}

/**
 * Безопасно извлекает только указанные записи из уже проверенного ZIP-архива.
 * Отклоняет path traversal, симлинки и несовпадение размера или SHA-256.
 */
export async function extractZipEntries(
  zipPath: string,
  entries: Map<string, ZipExtractSpec>,
  destRoot: string,
  signal?: AbortSignal,
  onFileDone?: (entryPath: string, bytes: number) => void
): Promise<void> {
  throwIfAborted(signal)
  const resolvedRoot = resolve(destRoot)
  await mkdir(resolvedRoot, { recursive: true })

  for (const [entryName, spec] of entries) {
    const err = checkRelativePath(entryName)
    if (err) {
      throw new LauncherError('manifest-invalid', 'Небезопасный путь в архиве', `Путь «${entryName}»: ${err}.`)
    }
    const target = resolve(spec.targetAbsPath)
    if (!isInside(resolvedRoot, target)) {
      throw new LauncherError(
        'manifest-invalid',
        'Небезопасный путь распаковки',
        `Путь назначения для «${entryName}» выходит за пределы каталога.`
      )
    }
  }

  const remaining = new Map(entries)
  const zip = await openZip(zipPath)
  try {
    for await (const entry of zip.eachEntry()) {
      throwIfAborted(signal)
      if (isZipSymlink(entry)) {
        throw new LauncherError(
          'manifest-invalid',
          'Символическая ссылка в архиве',
          `Архив содержит запрещённую символическую ссылку «${entry.fileName}».`
        )
      }
      const { clean, isDir } = validateZipEntryName(entry.fileName)
      if (isDir) continue

      const spec = remaining.get(clean)
      if (!spec) continue

      remaining.delete(clean)
      const target = resolve(spec.targetAbsPath)
      await mkdir(dirname(target), { recursive: true })
      await assertRealInside(resolvedRoot, target)

      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      let written = 0
      const hash = createHash('sha256')
      const verifier = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length
          if (written > spec.expectedSize) {
            cb(
              new LauncherError(
                'integrity',
                'Повреждённый архив',
                `Файл «${clean}» в архиве превышает заявленный размер (${spec.expectedSize} байт).`
              )
            )
            return
          }
          hash.update(chunk)
          cb(null, chunk)
        }
      })

      try {
        const readStream = await zip.openReadStreamPromise(entry)
        await pipeline(readStream, verifier, createWriteStream(tmp), { signal })
        if (written !== spec.expectedSize) {
          throw new LauncherError(
            'integrity',
            'Повреждённый архив',
            `Размер файла «${clean}» (${written}) не совпал с манифестом (${spec.expectedSize}).`
          )
        }
        const actualSha = hash.digest('hex')
        if (actualSha !== spec.expectedSha256) {
          throw new LauncherError(
            'integrity',
            'Повреждённый файл в архиве',
            `Контрольная сумма файла «${clean}» не совпала с манифестом.`
          )
        }
        await renameWithRetry(tmp, target)
        onFileDone?.(clean, written)
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined)
        if (signal?.aborted) throw new CancelledError()
        throw e
      }
    }
  } finally {
    try {
      zip.close()
    } catch {
      /* ignore */
    }
  }

  if (remaining.size > 0) {
    const firstMissing = remaining.keys().next().value
    throw new LauncherError(
      'integrity',
      'Неполный архив',
      `В архиве отсутствует ожидаемый файл «${firstMissing}».`,
      'Проверьте публикацию релиза или пересоберите архивы манифеста.'
    )
  }
}

function stripArchivePrefix(rawName: string, stripComponents: number): { rel: string; isDir: boolean } | null {
  const isDir = rawName.endsWith('/')
  const trimmed = isDir ? rawName.slice(0, -1) : rawName
  if (!trimmed) return null
  if (trimmed.includes('\\') || trimmed.startsWith('/')) {
    throw new LauncherError('manifest-invalid', 'Небезопасный путь в архиве', `Недопустимый путь «${rawName}».`)
  }
  const parts = trimmed.split('/')
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new LauncherError('manifest-invalid', 'Небезопасный путь в архиве', `Недопустимый путь «${rawName}».`)
    }
  }
  if (parts.length <= stripComponents) return null
  const rel = parts.slice(stripComponents).join('/')
  const err = checkRelativePath(rel)
  if (err) {
    throw new LauncherError('manifest-invalid', 'Небезопасный путь в архиве', `Путь «${rawName}»: ${err}.`)
  }
  return { rel, isDir }
}

/**
 * Безопасно распаковывает архив Java Runtime (`.zip` или `.tar.gz`),
 * проверяя все пути через `safeJoin` и запрещая симлинки, выходящие за пределы `destDir`.
 */
export async function extractArchiveSafe(
  archivePath: string,
  destDir: string,
  format: 'zip' | 'tar.gz',
  stripComponents = 0,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  const resolvedDest = resolve(destDir)
  await mkdir(resolvedDest, { recursive: true })

  if (format === 'zip') {
    const zip = await openZip(archivePath)
    try {
      for await (const entry of zip.eachEntry()) {
        throwIfAborted(signal)
        if (isZipSymlink(entry)) {
          throw new LauncherError(
            'manifest-invalid',
            'Символическая ссылка в архиве',
            `Архив Java содержит символическую ссылку «${entry.fileName}».`
          )
        }
        const stripped = stripArchivePrefix(entry.fileName, stripComponents)
        if (!stripped) continue
        const target = safeJoin(resolvedDest, stripped.rel)
        if (stripped.isDir) {
          await mkdir(target, { recursive: true })
          await assertRealInside(resolvedDest, target)
          continue
        }
        await mkdir(dirname(target), { recursive: true })
        await assertRealInside(resolvedDest, target)
        const tmp = `${target}.${process.pid}.tmp`
        try {
          const readStream = await zip.openReadStreamPromise(entry)
          await pipeline(readStream, createWriteStream(tmp), { signal })
          await renameWithRetry(tmp, target)
          const unixPerm = (entry.externalFileAttributes >>> 16) & 0o777
          if (process.platform !== 'win32' && (unixPerm & 0o111) !== 0) {
            await chmod(target, unixPerm | 0o600).catch(() => undefined)
          }
        } catch (e) {
          await rm(tmp, { force: true }).catch(() => undefined)
          if (signal?.aborted) throw new CancelledError()
          throw e
        }
      }
    } finally {
      try {
        zip.close()
      } catch {
        /* ignore */
      }
    }
    return
  }

  // Формат tar.gz: сначала проверяем список записей на безопасность путей и симлинков.
  const entriesList: Array<{ path: string; type: string; linkpath?: string }> = []
  await tar.t({
    file: archivePath,
    onReadEntry(entry) {
      entriesList.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath })
    }
  })

  for (const item of entriesList) {
    throwIfAborted(signal)
    const stripped = stripArchivePrefix(item.path, stripComponents)
    if (!stripped) continue
    safeJoin(resolvedDest, stripped.rel)
    if (item.type === 'SymbolicLink' || item.type === 'Link') {
      const linkTarget = item.linkpath ?? ''
      if (!linkTarget || linkTarget.startsWith('/') || linkTarget.includes('\\')) {
        throw new LauncherError(
          'manifest-invalid',
          'Небезопасная ссылка в архиве',
          `Запрещённая ссылка «${item.path}» -> «${linkTarget}».`
        )
      }
      const basePosix = item.type === 'SymbolicLink' ? posix.dirname(stripped.rel) : '.'
      const normalized = posix.normalize(posix.join(basePosix, linkTarget))
      if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
        throw new LauncherError(
          'manifest-invalid',
          'Небезопасная ссылка в архиве',
          `Ссылка «${item.path}» -> «${linkTarget}» выходит за пределы каталога назначения.`
        )
      }
    } else if (item.type !== 'File' && item.type !== 'Directory') {
      throw new LauncherError(
        'manifest-invalid',
        'Недопустимый тип файла в архиве',
        `Архив содержит неподдерживаемую запись типа ${item.type}: «${item.path}».`
      )
    }
  }

  throwIfAborted(signal)
  await tar.x({
    file: archivePath,
    cwd: resolvedDest,
    strip: stripComponents,
    preservePaths: false,
    unlink: true
  })
}
