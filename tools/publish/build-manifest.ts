import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import yazl from 'yazl'
import { sha256File } from '@core/hash'
import { checkRelativePath, matchesAny } from '@shared/paths'
import {
  ManifestSchema,
  PackInfoSchema,
  type Loader,
  type Manifest,
  type ManifestArchive,
  type ManifestFile,
  type PackInfo
} from '@shared/schemas'

export const DEFAULT_EXCLUDES = [
  '.git/**',
  '.abilauncher/**',
  'saves/**',
  'screenshots/**',
  'logs/**',
  'crash-reports/**',
  'backups/**',
  'versions/**',
  'libraries/**',
  '.mixin.out/**',
  'ForLauncher/**',
  'launcher/**',
  'schematics/**',
  'xaero/**',
  'XaeroWaypoints*/**',
  'local/crash_assistant/**',
  'local/ftbchunks/**',
  'fancymenu_data/fancymenu_temp/**',
  'fancymenu_data/last_world.fmdata',
  'gtceu/prospection_cache/**',
  'ESM/ServerWorld/**',
  'mods/.index/**',
  'tacz/.export-state.json',
  'usercache.json',
  'usernamecache.json',
  'launcher-index.json',
  'README.md',
  '.gitignore',
  '*.zip'
]

export const INITIAL_USER_FILES = [
  'options.txt',
  'optionsof.txt',
  'optionsshaders.txt',
  'servers.dat',
  'servers.dat_old',
  'emi.json',
  'patchouli_data.json',
  'tfcanvilhelper_gui.properties',
  'rhino.local.properties'
]

export const OPTIONAL_MANAGED_GLOBS = [
  'shaderpacks/**',
  'resourcepacks/**',
  'local/**'
]

export interface BuildPackReleaseOptions {
  sourceDir: string
  outDir: string
  packId: string
  name: string
  version: string
  minecraft: string
  loader: Loader
  repo: string
  releaseTag: string
  javaMajor?: number
  recommendedMemoryMb?: number
  summary?: string
  description?: string
  server?: { name: string; host: string; port?: number }
  cover?: string
  /** Порог в байтах: файлы меньше попадают в zip-части, больше — отдельными ассетами релиза. */
  archiveThresholdBytes?: number
  /** Максимальный несжатый объём одной zip-части. */
  maxPartBytes?: number
  extraExcludes?: string[]
  /** Переопределение базового URL релиза (по умолчанию GitHub Releases). */
  releaseBaseUrl?: string
}

export interface BuildPackReleaseResult {
  manifestPath: string
  packJsonPath: string
  releaseAssetsDir: string
  manifest: Manifest
  packInfo: PackInfo
  stats: {
    totalFiles: number
    archivedFiles: number
    directFiles: number
    archivesCount: number
  }
}

async function collectFiles(
  rootDir: string,
  excludes: string[]
): Promise<Array<{ rel: string; abs: string; size: number }>> {
  const result: Array<{ rel: string; abs: string; size: number }> = []

  async function walk(dir: string, relPrefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (matchesAny(`${rel}/_`, excludes)) continue
        await walk(abs, rel)
      } else if (entry.isFile()) {
        if (matchesAny(rel, excludes)) continue
        const err = checkRelativePath(rel)
        if (err) {
          throw new Error(`Недопустимое имя файла «${rel}»: ${err}`)
        }
        const st = await stat(abs)
        result.push({ rel, abs, size: st.size })
      }
    }
  }

  await walk(rootDir, '')
  return result
}

async function writeZipPart(
  zipPath: string,
  items: Array<{ rel: string; abs: string }>
): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const item of items) {
    zip.addFile(item.abs, item.rel, { compress: true })
  }
  const done = pipeline(zip.outputStream, createWriteStream(zipPath))
  zip.end()
  await done
}

function makeReleaseAssetName(rel: string, sha: string): string {
  const base = basename(rel).replace(/[^A-Za-z0-9._-]/g, '_')
  return `${sha.slice(0, 10)}-${base}`
}

export async function buildPackRelease(opts: BuildPackReleaseOptions): Promise<BuildPackReleaseResult> {
  const sourceDir = resolve(opts.sourceDir)
  const outDir = resolve(opts.outDir)
  const releaseAssetsDir = join(outDir, 'release-assets')
  const launcherOutDir = join(outDir, 'ForLauncher')
  await mkdir(releaseAssetsDir, { recursive: true })
  await mkdir(launcherOutDir, { recursive: true })

  const releaseBaseUrl =
    opts.releaseBaseUrl ??
    `https://github.com/${opts.repo}/releases/download/${encodeURIComponent(opts.releaseTag)}`

  const excludes = [...DEFAULT_EXCLUDES, ...(opts.extraExcludes ?? [])]
  const threshold = opts.archiveThresholdBytes ?? 4 * 1024 * 1024
  const maxPartBytes = opts.maxPartBytes ?? 200 * 1024 * 1024

  const scanned = await collectFiles(sourceDir, excludes)
  const directItems: typeof scanned = []
  const smallItems: typeof scanned = []

  for (const f of scanned) {
    if (f.size >= threshold) directItems.push(f)
    else smallItems.push(f)
  }

  const manifestFiles: ManifestFile[] = []
  const manifestArchives: ManifestArchive[] = []

  // 1. Крупные файлы — отдельными ассетами релиза (в пределах 2 ГБ на файл в GitHub Releases)
  const usedAssetNames = new Set<string>()
  for (const item of directItems) {
    const hash = await sha256File(item.abs)
    let assetName = makeReleaseAssetName(item.rel, hash)
    let counter = 1
    while (usedAssetNames.has(assetName.toLowerCase())) {
      assetName = `${hash.slice(0, 10)}-${counter++}-${basename(item.rel).replace(/[^A-Za-z0-9._-]/g, '_')}`
    }
    usedAssetNames.add(assetName.toLowerCase())

    await copyFile(item.abs, join(releaseAssetsDir, assetName))
    const isInitial = matchesAny(item.rel, INITIAL_USER_FILES)
    const isOptional = isInitial || matchesAny(item.rel, OPTIONAL_MANAGED_GLOBS)
    manifestFiles.push({
      path: item.rel,
      size: item.size,
      sha256: hash,
      mode: isInitial ? 'initial' : 'managed',
      required: !isOptional,
      source: { url: `${releaseBaseUrl}/${assetName}` }
    })
  }

  // 2. Мелкие файлы — группируем в zip-части (экономим запросы к GitHub)
  let partIdx = 1
  let batch: typeof smallItems = []
  let batchBytes = 0

  const flushBatch = async () => {
    if (batch.length === 0) return
    const archiveId = `pack-part-${String(partIdx).padStart(2, '0')}`
    partIdx++
    const zipFileName = `${archiveId}.zip`
    const zipPath = join(releaseAssetsDir, zipFileName)
    await writeZipPart(zipPath, batch)
    const zipSt = await stat(zipPath)
    const zipSha = await sha256File(zipPath)

    manifestArchives.push({
      id: archiveId,
      url: `${releaseBaseUrl}/${zipFileName}`,
      size: zipSt.size,
      sha256: zipSha
    })

    for (const item of batch) {
      const hash = await sha256File(item.abs)
      const isInitial = matchesAny(item.rel, INITIAL_USER_FILES)
      const isOptional = isInitial || matchesAny(item.rel, OPTIONAL_MANAGED_GLOBS)
      manifestFiles.push({
        path: item.rel,
        size: item.size,
        sha256: hash,
        mode: isInitial ? 'initial' : 'managed',
        required: !isOptional,
        source: { archive: archiveId, entry: item.rel }
      })
    }
    batch = []
    batchBytes = 0
  }

  for (const item of smallItems) {
    if (batch.length > 0 && batchBytes + item.size > maxPartBytes) {
      await flushBatch()
    }
    batch.push(item)
    batchBytes += item.size
  }
  await flushBatch()

  manifestFiles.sort((a, b) => a.path.localeCompare(b.path))

  const manifestCandidate: Manifest = {
    schemaVersion: 1,
    packId: opts.packId,
    version: opts.version,
    createdAt: new Date().toISOString(),
    minecraft: opts.minecraft,
    loader: opts.loader,
    ...(opts.javaMajor ? { java: { major: opts.javaMajor } } : {}),
    archives: manifestArchives,
    files: manifestFiles
  }

  const manifest = ManifestSchema.parse(manifestCandidate)
  const manifestPath = join(releaseAssetsDir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  const packInfoCandidate: PackInfo = {
    schemaVersion: 1,
    id: opts.packId,
    name: opts.name,
    summary: opts.summary ?? '',
    description: opts.description ?? '',
    ...(opts.cover ? { cover: opts.cover } : {}),
    version: opts.version,
    minecraft: opts.minecraft,
    loader: opts.loader,
    recommendedMemoryMb: opts.recommendedMemoryMb ?? 8192,
    manifestUrl: `${releaseBaseUrl}/manifest.json`,
    ...(opts.server ? { server: opts.server } : {}),
    news: 'ForLauncher/news.json'
  }

  const packInfo = PackInfoSchema.parse(packInfoCandidate)
  const packJsonPath = join(launcherOutDir, 'pack.json')
  await writeFile(packJsonPath, JSON.stringify(packInfo, null, 2), 'utf8')

  return {
    manifestPath,
    packJsonPath,
    releaseAssetsDir,
    manifest,
    packInfo,
    stats: {
      totalFiles: manifestFiles.length,
      archivedFiles: smallItems.length,
      directFiles: directItems.length,
      archivesCount: manifestArchives.length
    }
  }
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const val = argv[i + 1]
      if (val && !val.startsWith('--')) {
        args[key] = val
        i++
      } else {
        args[key] = 'true'
      }
    }
  }
  return args
}

async function runCli(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help || !args.source || !args.out || !args.id || !args.version || !args.mc || !args.repo) {
    console.log(`Использование:
  npm run pack-tool -- \\
    --source "D:/path/to/modpack" \\
    --out "./dist-pack" \\
    --id "my-pack" \\
    --name "Моя сборка" \\
    --version "1.0.0" \\
    --mc "1.20.1" \\
    --loader "forge:47.4.13" \\
    --repo "Owner/MyPackRepo" \\
    [--tag "v1.0.0"] \\
    [--java 17] \\
    [--memory 6144] \\
    [--server "Сервер:mc.example.com:25565"] \\
    [--cover "ForLauncher/bg-tfg.jpg"] \\
    [--summary "Краткое описание"] \\
    [--description "Полное описание"] \\
    [--threshold-mb 4] \\
    [--max-part-mb 200]
`)
    process.exit(args.help ? 0 : 1)
  }

  const loaderRaw = args.loader ?? 'vanilla'
  let loader: Loader
  if (loaderRaw === 'vanilla') {
    loader = { type: 'vanilla' }
  } else {
    const [type, ver] = loaderRaw.split(':')
    if ((type !== 'fabric' && type !== 'forge' && type !== 'neoforge') || !ver) {
      throw new Error('Параметр --loader должен быть vanilla, fabric:<ver>, forge:<ver> или neoforge:<ver>')
    }
    loader = { type, version: ver }
  }

  let server: BuildPackReleaseOptions['server']
  if (args.server) {
    const parts = args.server.split(':')
    if (parts.length >= 2) {
      server = {
        name: parts[0],
        host: parts[1],
        port: parts[2] ? Number(parts[2]) : undefined
      }
    }
  }

  const thresholdMb = args['threshold-mb'] ? Number(args['threshold-mb']) : 4
  const maxPartMb = args['max-part-mb'] ? Number(args['max-part-mb']) : 200
  const res = await buildPackRelease({
    sourceDir: args.source,
    outDir: args.out,
    packId: args.id,
    name: args.name ?? args.id,
    version: args.version,
    minecraft: args.mc,
    loader,
    repo: args.repo,
    releaseTag: args.tag ?? args.version,
    javaMajor: args.java ? Number(args.java) : undefined,
    recommendedMemoryMb: args.memory ? Number(args.memory) : 8192,
    summary: args.summary,
    description: args.description,
    cover: args.cover,
    server,
    archiveThresholdBytes: thresholdMb * 1024 * 1024,
    maxPartBytes: maxPartMb * 1024 * 1024
  })

  console.log('Готово!')
  console.log(`  pack.json:      ${res.packJsonPath}`)
  console.log(`  manifest.json:  ${res.manifestPath}`)
  console.log(`  release-assets: ${res.releaseAssetsDir}`)
  console.log(`  Файлов всего:   ${res.stats.totalFiles} (в архивах: ${res.stats.archivedFiles}, отдельно: ${res.stats.directFiles}, zip-частей: ${res.stats.archivesCount})`)
}

const isEntrypoint =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isEntrypoint) {
  runCli().catch((e) => {
    console.error('Ошибка сборки релиза:', e)
    process.exit(1)
  })
}
