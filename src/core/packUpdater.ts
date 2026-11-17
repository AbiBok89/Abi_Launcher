import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LAUNCHER_META_DIR, matchesAny, pathKey } from '@shared/paths'
import type { FileMode, Manifest, ManifestFile } from '@shared/schemas'
import type { ConflictChoice, ConflictView, Stage } from '@shared/types'
import { extractZipEntries, type ZipExtractSpec } from './archive'
import { LauncherError, throwIfAborted } from './errors'
import {
  assertFreeSpace,
  assertRealInside,
  ensureDir,
  readJsonFile,
  removeQuiet,
  renameWithRetry,
  safeJoin,
  writeJsonAtomic
} from './fsutil'
import { sha256File } from './hash'
import { downloadVerified, type RequestOptions } from './http'
import { logger } from './log'

const log = logger.scope('updater')

/** Пользовательские пути, которые лаунчер никогда не удаляет автоматически как устаревшие. */
export const PROTECTED_USER_GLOBS = [
  'saves/**',
  'screenshots/**',
  'resourcepacks/**',
  'shaderpacks/**',
  'schematics/**',
  'xaero/**',
  'journeymap/**',
  'logs/**',
  'crash-reports/**',
  'backups/**',
  'options.txt',
  'optionsof.txt',
  'optionsshaders.txt',
  'servers.dat',
  'servers.dat_old',
  'usercache.json',
  'usernamecache.json',
  `${LAUNCHER_META_DIR}/**`
] as const

export interface ManagedFileRecord {
  sha256: string
  size: number
  mtimeMs: number
  mode: FileMode
  keptByUser?: boolean
  targetSha256?: string
}

export interface PackInstanceState {
  schemaVersion: 1
  packId: string
  version: string
  updatedAt: string
  managed: Record<string, ManagedFileRecord>
}

export interface SyncProgress {
  stage: Stage
  label: string
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  speed: number
}

export interface SyncPlan {
  manifestVersion: string
  upToDate: ManifestFile[]
  toDownload: ManifestFile[]
  toDelete: string[]
  untouchedInitial: ManifestFile[]
  keptByUser: Array<{ file: ManifestFile; diskRecord: ManagedFileRecord }>
  conflicts: ConflictView[]
  conflictFiles: Map<string, ManifestFile>
  warnings: string[]
  previousState: PackInstanceState | null
}

export interface PlanOptions {
  fullVerify?: boolean
  signal?: AbortSignal
  onProgress?: (p: SyncProgress) => void
}

export interface ApplyOptions extends RequestOptions {
  onProgress?: (p: SyncProgress) => void
  concurrency?: number
}

export function stateFilePath(instanceDir: string): string {
  return join(instanceDir, LAUNCHER_META_DIR, 'state.json')
}

export async function readPackState(instanceDir: string): Promise<PackInstanceState | null> {
  try {
    const raw = await readJsonFile<PackInstanceState>(stateFilePath(instanceDir))
    if (raw && raw.schemaVersion === 1 && raw.managed && typeof raw.managed === 'object') {
      return raw
    }
    return null
  } catch {
    return null
  }
}

async function listExtraMods(
  instanceDir: string,
  manifestKeys: Set<string>,
  deleteKeys: Set<string>,
  conflictKeys: Set<string>,
  signal?: AbortSignal
): Promise<string[]> {
  const modsDir = join(instanceDir, 'mods')
  const extras: string[] = []
  async function walk(dir: string, relPrefix: string): Promise<void> {
    throwIfAborted(signal)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) {
        const key = pathKey(rel)
        if (!manifestKeys.has(key) && !deleteKeys.has(key) && !conflictKeys.has(key)) {
          extras.push(entry.name)
        }
      }
    }
  }
  await walk(modsDir, 'mods')
  return extras.sort()
}

export async function planPackSync(
  instanceDir: string,
  manifest: Manifest,
  opts: PlanOptions = {}
): Promise<SyncPlan> {
  throwIfAborted(opts.signal)
  await ensureDir(instanceDir)
  const fullVerify = opts.fullVerify ?? true
  const previousState = await readPackState(instanceDir)

  const upToDate: ManifestFile[] = []
  const toDownload: ManifestFile[] = []
  const toDelete: string[] = []
  const untouchedInitial: ManifestFile[] = []
  const keptByUser: Array<{ file: ManifestFile; diskRecord: ManagedFileRecord }> = []
  const conflicts: ConflictView[] = []
  const conflictFiles = new Map<string, ManifestFile>()
  const manifestKeys = new Set<string>()

  const totalFiles = manifest.files.length
  let checkedFiles = 0

  const stateByKey = new Map<string, { rel: string; rec: ManagedFileRecord }>()
  if (previousState) {
    for (const [rel, rec] of Object.entries(previousState.managed)) {
      stateByKey.set(pathKey(rel), { rel, rec })
    }
  }

  for (const file of manifest.files) {
    throwIfAborted(opts.signal)
    const key = pathKey(file.path)
    manifestKeys.add(key)

    const abs = safeJoin(instanceDir, file.path)
    await assertRealInside(instanceDir, abs)

    let st: Awaited<ReturnType<typeof lstat>> | null = null
    try {
      st = await lstat(abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }

    if (st) {
      if (st.isSymbolicLink()) {
        throw new LauncherError(
          'filesystem',
          'Обнаружена символическая ссылка',
          `Файл «${file.path}» является символической ссылкой, что запрещено.`
        )
      }
      if (st.isDirectory()) {
        throw new LauncherError(
          'filesystem',
          'Конфликт папки и файла',
          `На месте файла «${file.path}» находится папка. Удалите или переименуйте её вручную.`
        )
      }
    }

    if (!st) {
      toDownload.push(file)
    } else if (file.mode === 'initial') {
      untouchedInitial.push(file)
    } else {
      const prev = stateByKey.get(key)?.rec
      let diskSha: string
      if (
        !fullVerify &&
        prev &&
        prev.mode === 'managed' &&
        !prev.keptByUser &&
        prev.size === st.size &&
        Math.abs(prev.mtimeMs - st.mtimeMs) < 0.001 &&
        prev.sha256 === file.sha256
      ) {
        diskSha = prev.sha256
      } else {
        diskSha = await sha256File(abs, opts.signal)
      }

      if (diskSha === file.sha256) {
        upToDate.push(file)
      } else if (prev && prev.mode === 'managed') {
        if (prev.keptByUser) {
          if (!file.required && prev.targetSha256 === file.sha256 && diskSha === prev.sha256) {
            keptByUser.push({
              file,
              diskRecord: {
                sha256: diskSha,
                size: st.size,
                mtimeMs: st.mtimeMs,
                mode: 'managed',
                keptByUser: true,
                targetSha256: file.sha256
              }
            })
          } else {
            conflicts.push({ path: file.path, kind: 'modified', canKeep: !file.required })
            conflictFiles.set(file.path, file)
          }
        } else if (diskSha === prev.sha256) {
          // Файл не менялся пользователем — пришло обновление сборки
          toDownload.push(file)
        } else {
          conflicts.push({ path: file.path, kind: 'modified', canKeep: !file.required })
          conflictFiles.set(file.path, file)
        }
      } else {
        conflicts.push({ path: file.path, kind: 'untracked', canKeep: !file.required })
        conflictFiles.set(file.path, file)
      }
    }

    checkedFiles++
    if (checkedFiles % 100 === 0 || checkedFiles === totalFiles) {
      opts.onProgress?.({
        stage: 'verify',
        label: `Проверка файлов сборки (${checkedFiles} / ${totalFiles})`,
        bytesDone: checkedFiles,
        bytesTotal: Math.max(1, totalFiles),
        filesDone: checkedFiles,
        filesTotal: totalFiles,
        speed: 0
      })
    }
  }

  // Проверка устаревших файлов, ранее установленных лаунчером
  if (previousState) {
    for (const [rel, rec] of Object.entries(previousState.managed)) {
      throwIfAborted(opts.signal)
      if (rec.mode !== 'managed') continue
      if (manifestKeys.has(pathKey(rel))) continue
      if (matchesAny(rel, PROTECTED_USER_GLOBS)) continue

      const abs = safeJoin(instanceDir, rel)
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try {
        st = await lstat(abs)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      if (!st || !st.isFile()) continue

      const diskSha = await sha256File(abs, opts.signal)
      if (!rec.keptByUser && diskSha === rec.sha256) {
        toDelete.push(rel)
      } else {
        conflicts.push({ path: rel, kind: 'obsolete-modified', canKeep: true })
      }
    }
  }

  const deleteKeys = new Set(toDelete.map(pathKey))
  const conflictKeys = new Set(conflicts.map((c) => pathKey(c.path)))
  const extraMods = await listExtraMods(instanceDir, manifestKeys, deleteKeys, conflictKeys, opts.signal)
  const warnings: string[] = []
  if (extraMods.length > 0) {
    const shown = extraMods.slice(0, 5).join(', ')
    const suffix = extraMods.length > 5 ? ` и ещё ${extraMods.length - 5}` : ''
    warnings.push(
      `Найдены дополнительные моды игрока (${extraMods.length}): ${shown}${suffix}. Они сохранены, но могут быть несовместимы со сборкой или сервером.`
    )
  }

  return {
    manifestVersion: manifest.version,
    upToDate,
    toDownload,
    toDelete,
    untouchedInitial,
    keptByUser,
    conflicts,
    conflictFiles,
    warnings,
    previousState
  }
}

function safeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

export async function applyPackSync(
  instanceDir: string,
  manifest: Manifest,
  plan: SyncPlan,
  resolutions: Record<string, ConflictChoice> = {},
  opts: ApplyOptions = {}
): Promise<PackInstanceState> {
  throwIfAborted(opts.signal)
  await ensureDir(instanceDir)

  // Проверяем решения по всем конфликтам до любых загрузок
  for (const conflict of plan.conflicts) {
    const choice = resolutions[conflict.path]
    if (!choice) {
      throw new LauncherError(
        'conflict',
        'Требуется решение по изменённым файлам',
        `Обнаружен конфликт файла «${conflict.path}». Выберите, заменить его или оставить.`,
        'Выберите действие для всех конфликтных файлов и повторите запуск.'
      )
    }
    if (choice === 'keep' && !conflict.canKeep) {
      throw new LauncherError(
        'conflict',
        'Обязательный файл нельзя пропустить',
        `Файл «${conflict.path}» обязателен для работы сборки и должен быть заменён (с созданием резервной копии).`
      )
    }
  }

  const filesToStage: ManifestFile[] = [...plan.toDownload]
  const backupTargets: string[] = []
  const deleteTargets: string[] = [...plan.toDelete]
  const keepEntries: Array<{ file: ManifestFile; record: ManagedFileRecord }> = [...plan.keptByUser.map((k) => ({ file: k.file, record: k.diskRecord }))]

  for (const conflict of plan.conflicts) {
    const choice = resolutions[conflict.path]!
    if (conflict.kind === 'obsolete-modified') {
      if (choice === 'replace') {
        backupTargets.push(conflict.path)
        deleteTargets.push(conflict.path)
      }
      // При choice === 'keep' файл остаётся у игрока и выводится из state.managed
      continue
    }

    const file = plan.conflictFiles.get(conflict.path)!
    if (choice === 'replace') {
      backupTargets.push(conflict.path)
      filesToStage.push(file)
    } else {
      const abs = safeJoin(instanceDir, file.path)
      const st = await stat(abs)
      const diskSha = await sha256File(abs, opts.signal)
      keepEntries.push({
        file,
        record: {
          sha256: diskSha,
          size: st.size,
          mtimeMs: st.mtimeMs,
          mode: 'managed',
          keptByUser: true,
          targetSha256: file.sha256
        }
      })
    }
  }

  const metaDir = join(instanceDir, LAUNCHER_META_DIR)
  const stagingDir = join(metaDir, 'staging', safeTag(manifest.version))
  const stagingFilesDir = join(stagingDir, 'files')
  const stagingArchivesDir = join(stagingDir, 'archives')

  // Проверяем, что уже есть в staging после прерывания
  const pendingFiles: ManifestFile[] = []
  let bytesAlreadyStaged = 0
  const totalBytesFiles = filesToStage.reduce((acc, f) => acc + f.size, 0)

  for (const file of filesToStage) {
    throwIfAborted(opts.signal)
    const stagedPath = safeJoin(stagingFilesDir, file.path)
    let ready = false
    try {
      const st = await stat(stagedPath)
      if (st.isFile() && st.size === file.size) {
        const h = await sha256File(stagedPath, opts.signal)
        if (h === file.sha256) {
          ready = true
          bytesAlreadyStaged += file.size
        }
      }
    } catch {
      ready = false
    }
    if (!ready) pendingFiles.push(file)
  }

  const neededArchiveIds = new Set<string>()
  const archivePendingFiles = new Map<string, ManifestFile[]>()
  const directPendingFiles: ManifestFile[] = []

  for (const file of pendingFiles) {
    if ('archive' in file.source) {
      neededArchiveIds.add(file.source.archive)
      const list = archivePendingFiles.get(file.source.archive) ?? []
      list.push(file)
      archivePendingFiles.set(file.source.archive, list)
    } else {
      directPendingFiles.push(file)
    }
  }

  const neededArchives = manifest.archives.filter((a) => neededArchiveIds.has(a.id))
  const pendingArchiveBytes = neededArchives.reduce((s, a) => s + a.size, 0)
  const pendingDirectBytes = directPendingFiles.reduce((s, f) => s + f.size, 0)
  const totalDownloadBytes = Math.max(totalBytesFiles, bytesAlreadyStaged + pendingArchiveBytes + pendingDirectBytes)

  if (pendingFiles.length > 0) {
    await assertFreeSpace(instanceDir, pendingArchiveBytes + pendingDirectBytes + pendingFiles.reduce((s, f) => s + f.size, 0))
    await ensureDir(stagingFilesDir)
    await ensureDir(stagingArchivesDir)
  }

  let bytesDone = bytesAlreadyStaged
  let filesDone = filesToStage.length - pendingFiles.length
  const totalFilesCount = filesToStage.length

  // Скользящий расчёт скорости загрузки
  let speedBytes = 0
  let speedWindowStart = Date.now()
  let currentSpeed = 0

  const emitProgress = (stage: Stage, label: string, delta = 0) => {
    bytesDone = Math.max(0, bytesDone + delta)
    if (delta > 0) speedBytes += delta
    const now = Date.now()
    const elapsed = now - speedWindowStart
    if (elapsed >= 400) {
      currentSpeed = Math.round((speedBytes * 1000) / elapsed)
      speedBytes = 0
      speedWindowStart = now
    }
    opts.onProgress?.({
      stage,
      label,
      bytesDone: Math.min(bytesDone, totalDownloadBytes),
      bytesTotal: totalDownloadBytes,
      filesDone,
      filesTotal: totalFilesCount,
      speed: currentSpeed
    })
  }

  if (pendingFiles.length > 0) {
    emitProgress('download', 'Подготовка загрузки файлов сборки')
  }

  // 1. Скачиваем и распаковываем нужные архивы
  for (const archive of neededArchives) {
    throwIfAborted(opts.signal)
    const archivePath = join(stagingArchivesDir, `${archive.id}.zip`)
    let archiveReady = false
    try {
      const st = await stat(archivePath)
      if (st.isFile() && st.size === archive.size) {
        if ((await sha256File(archivePath, opts.signal)) === archive.sha256) {
          archiveReady = true
          emitProgress('download', `Архив ${archive.id} найден во временной папке`, archive.size)
        }
      }
    } catch {
      archiveReady = false
    }

    if (!archiveReady) {
      await downloadVerified(archive.url, archivePath, {
        ...opts,
        expectedSize: archive.size,
        expectedSha256: archive.sha256,
        onBytes: (delta) => emitProgress('download', `Загрузка архива ${archive.id}`, delta)
      })
    }

    const wanted = archivePendingFiles.get(archive.id) ?? []
    const specMap = new Map<string, ZipExtractSpec>()
    for (const file of wanted) {
      const src = file.source as { archive: string; entry: string }
      const targetAbs = safeJoin(stagingFilesDir, file.path)
      specMap.set(src.entry, {
        targetAbsPath: targetAbs,
        expectedSize: file.size,
        expectedSha256: file.sha256
      })
    }

    emitProgress('extract', `Распаковка архива ${archive.id}`)
    await extractZipEntries(archivePath, specMap, stagingFilesDir, opts.signal, () => {
      filesDone++
      emitProgress('extract', `Распаковка архива ${archive.id} (${filesDone} / ${totalFilesCount})`)
    })
  }

  // 2. Скачиваем прямые файлы с ограничением параллельности
  if (directPendingFiles.length > 0) {
    const queue = [...directPendingFiles]
    const workersCount = Math.min(opts.concurrency ?? 4, queue.length)
    const workers = Array.from({ length: workersCount }, async () => {
      for (;;) {
        throwIfAborted(opts.signal)
        const file = queue.shift()
        if (!file) return
        const src = file.source as { url: string }
        const dest = safeJoin(stagingFilesDir, file.path)
        await downloadVerified(src.url, dest, {
          ...opts,
          expectedSize: file.size,
          expectedSha256: file.sha256,
          onBytes: (delta) =>
            emitProgress('download', `Загрузка файлов (${filesDone} / ${totalFilesCount})`, delta)
        })
        filesDone++
        emitProgress('download', `Загрузка файлов (${filesDone} / ${totalFilesCount})`)
      }
    })
    await Promise.all(workers)
  }

  // 3. Финальная проверка целостности staging до любых изменений в папке сборки
  for (const file of filesToStage) {
    throwIfAborted(opts.signal)
    const stagedPath = safeJoin(stagingFilesDir, file.path)
    const st = await stat(stagedPath).catch(() => null)
    if (!st || !st.isFile() || st.size !== file.size) {
      throw new LauncherError(
        'integrity',
        'Повреждённый временный файл',
        `Временный файл «${file.path}» отсутствует или имеет неверный размер.`
      )
    }
    const h = await sha256File(stagedPath, opts.signal)
    if (h !== file.sha256) {
      await rm(stagedPath, { force: true }).catch(() => undefined)
      throw new LauncherError(
        'integrity',
        'Нарушена целостность файла',
        `Контрольная сумма подготовленного файла «${file.path}» не совпала с манифестом.`
      )
    }
  }

  // 4. Применение изменений: бэкапы, перенос из staging, удаление устаревших
  opts.onProgress?.({
    stage: 'apply',
    label: 'Применение файлов сборки',
    bytesDone: totalDownloadBytes,
    bytesTotal: totalDownloadBytes,
    filesDone: totalFilesCount,
    filesTotal: totalFilesCount,
    speed: 0
  })

  if (backupTargets.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupRoot = join(metaDir, 'backups', stamp)
    for (const rel of backupTargets) {
      const src = safeJoin(instanceDir, rel)
      const dst = safeJoin(backupRoot, rel)
      await ensureDir(dirname(dst))
      await copyFile(src, dst)
      log.info(`Создана резервная копия ${rel} -> ${dst}`)
    }
  }

  for (const file of filesToStage) {
    const src = safeJoin(stagingFilesDir, file.path)
    const dst = safeJoin(instanceDir, file.path)
    await assertRealInside(instanceDir, dst)
    await ensureDir(dirname(dst))
    await renameWithRetry(src, dst)
  }

  for (const rel of deleteTargets) {
    const target = safeJoin(instanceDir, rel)
    await assertRealInside(instanceDir, target)
    await rm(target, { force: true })
  }

  // 5. Формирование и сохранение state.json
  const nextManaged: Record<string, ManagedFileRecord> = {}
  const keptMap = new Map(keepEntries.map((k) => [pathKey(k.file.path), k.record]))

  for (const file of manifest.files) {
    const kept = keptMap.get(pathKey(file.path))
    if (kept) {
      nextManaged[file.path] = kept
      continue
    }
    const abs = safeJoin(instanceDir, file.path)
    const st = await stat(abs)
    if (file.mode === 'initial') {
      const diskSha = await sha256File(abs, opts.signal)
      nextManaged[file.path] = {
        sha256: diskSha,
        size: st.size,
        mtimeMs: st.mtimeMs,
        mode: 'initial'
      }
    } else {
      nextManaged[file.path] = {
        sha256: file.sha256,
        size: file.size,
        mtimeMs: st.mtimeMs,
        mode: 'managed'
      }
    }
  }

  const nextState: PackInstanceState = {
    schemaVersion: 1,
    packId: manifest.packId,
    version: manifest.version,
    updatedAt: new Date().toISOString(),
    managed: nextManaged
  }

  await writeJsonAtomic(stateFilePath(instanceDir), nextState)
  await removeQuiet(stagingDir)

  return nextState
}
