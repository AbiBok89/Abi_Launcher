import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LAUNCHER_META_DIR } from '@shared/paths'
import type {
  CatalogResult,
  NewsItemView,
  NewsResult,
  PackLoadError,
  PackStatus,
  PackView,
  Settings
} from '@shared/types'
import {
  CatalogSchema,
  NewsSchema,
  createLegacyLauncherIndexSchema,
  createManifestSchema,
  createPackInfoSchema,
  formatZodError,
  isAllowedUrl,
  legacyIndexToNews,
  legacyIndexToPackInfos,
  type Manifest,
  type News,
  type PackInfo,
  type UrlValidator
} from '@shared/schemas'
import { LauncherError, isAbortError } from './errors'
import { ensureDir, readJsonFile, writeJsonAtomic } from './fsutil'
import { rawUrl } from './github'
import { sha256Text } from './hash'
import { fetchBuffer, fetchText, type RequestOptions } from './http'
import { logger } from './log'

const log = logger.scope('catalog')

export interface PackSourceRef {
  repo: string
  branch: string
  path: string
  official: boolean
  packId?: string
  newsPath?: string
}

export interface CatalogRequestOptions extends RequestOptions {
  resolveRawUrl?: (ref: { repo: string; branch: string }, path: string) => string
}

export interface StoredPackRecord {
  packId: string
  version: string
  updatedAt: string
  managed: Record<string, unknown>
}

interface CatalogCacheFile {
  loadedAt: string
  packs: Array<PackView & { sourceRef: PackSourceRef; manifestUrl: string; newsPath: string }>
}

export interface LoadedPackEntry {
  view: PackView
  sourceRef: PackSourceRef
  packInfo: PackInfo
}

export function makePackKey(repo: string, packId: string): string {
  return `${repo.replace(/[^A-Za-z0-9._-]/g, '_')}__${packId}`
}

function getRawUrl(
  ref: { repo: string; branch: string },
  path: string,
  opts?: CatalogRequestOptions
): string {
  return (opts?.resolveRawUrl ?? rawUrl)(ref, path)
}

function getUrlValidator(opts?: CatalogRequestOptions): UrlValidator {
  return opts?.isAllowed ?? isAllowedUrl
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof LauncherError && err.code === 'github-unavailable' && err.message.includes('(404)')
}

function detectImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

async function fetchJsonSafe(url: string, opts?: CatalogRequestOptions, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const text = await fetchText(url, { ...opts, maxBytes })
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new LauncherError(
      'manifest-invalid',
      'Некорректный JSON',
      `Файл ${url} не является корректным JSON: ${(e as Error).message}.`
    )
  }
}

async function fetchPackInfosFromRepo(
  ref: PackSourceRef,
  opts?: CatalogRequestOptions
): Promise<PackInfo[]> {
  const validator = getUrlValidator(opts)
  const PackSchema = createPackInfoSchema(validator)
  const LegacySchema = createLegacyLauncherIndexSchema(validator)

  const candidates =
    ref.path === 'ForLauncher/pack.json'
      ? ['ForLauncher/pack.json', 'launcher/pack.json', 'launcher-index.json']
      : ref.path === 'launcher/pack.json'
        ? ['launcher/pack.json', 'ForLauncher/pack.json', 'launcher-index.json']
        : [ref.path]

  let lastErr: unknown
  for (let i = 0; i < candidates.length; i++) {
    const candidatePath = candidates[i]
    const url = getRawUrl(ref, candidatePath, opts)
    try {
      const raw = await fetchJsonSafe(url, opts)
      if (candidatePath.endsWith('launcher-index.json')) {
        const parsedLegacy = LegacySchema.safeParse(raw)
        if (!parsedLegacy.success) {
          throw new LauncherError('manifest-invalid', 'Ошибка индекса сборки', formatZodError(parsedLegacy.error))
        }
        return legacyIndexToPackInfos(parsedLegacy.data)
      }
      const parsed = PackSchema.safeParse(raw)
      if (parsed.success) return [parsed.data]

      const fallbackLegacy = LegacySchema.safeParse(raw)
      if (fallbackLegacy.success) return legacyIndexToPackInfos(fallbackLegacy.data)

      throw new LauncherError('manifest-invalid', 'Ошибка описания сборки', formatZodError(parsed.error))
    } catch (err) {
      lastErr = err
      if (isNotFoundError(err) && i < candidates.length - 1) {
        continue
      }
      throw err
    }
  }
  throw lastErr
}

async function loadCoverDataUrl(
  ref: PackSourceRef,
  cover: string | undefined,
  cacheDir: string,
  opts?: CatalogRequestOptions
): Promise<string | null> {
  if (!cover) return null
  const coverUrl = /^https?:\/\//i.test(cover) ? cover : getRawUrl(ref, cover, opts)
  const cacheFile = join(cacheDir, 'covers', `${sha256Text(coverUrl)}.txt`)
  try {
    const { data } = await fetchBuffer(coverUrl, { ...opts, maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000 })
    const mime = detectImageMime(data)
    if (!mime) return null
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`
    await ensureDir(join(cacheDir, 'covers'))
    await writeJsonAtomic(cacheFile, { url: coverUrl, dataUrl }).catch(() => undefined)
    return dataUrl
  } catch {
    try {
      const cached = await readJsonFile<{ dataUrl?: string }>(cacheFile)
      return cached?.dataUrl ?? null
    } catch {
      return null
    }
  }
}

export async function readInstalledPackVersion(installDir: string, packKey: string): Promise<string | null> {
  try {
    const statePath = join(installDir, 'instances', packKey, LAUNCHER_META_DIR, 'state.json')
    const data = JSON.parse(await readFile(statePath, 'utf8')) as Partial<StoredPackRecord>
    return typeof data.version === 'string' && data.version.length > 0 ? data.version : null
  } catch {
    return null
  }
}

export interface LocalPackMeta {
  schemaVersion: 1
  packKey: string
  sourceRef: PackSourceRef
  packInfo: PackInfo
  coverDataUrl?: string | null
}

export async function saveLocalPackMeta(instanceDir: string, meta: LocalPackMeta): Promise<void> {
  await ensureDir(join(instanceDir, LAUNCHER_META_DIR))
  await writeJsonAtomic(join(instanceDir, LAUNCHER_META_DIR, 'pack.json'), meta)
}

async function scanLocalInstalledPacks(
  installDir: string,
  urlCheck: UrlValidator = isAllowedUrl
): Promise<Array<{ view: PackView; sourceRef: PackSourceRef; packInfo: PackInfo }>> {
  const instancesRoot = join(installDir, 'instances')
  let dirs
  try {
    dirs = await readdir(instancesRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const PackSchema = createPackInfoSchema(urlCheck)
  const out: Array<{ view: PackView; sourceRef: PackSourceRef; packInfo: PackInfo }> = []

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const packKey = dir.name
    const installedVersion = await readInstalledPackVersion(installDir, packKey)
    if (!installedVersion) continue

    const metaPath = join(instancesRoot, packKey, LAUNCHER_META_DIR, 'pack.json')
    const rawMeta = await readJsonFile<Partial<LocalPackMeta>>(metaPath).catch(() => null)
    if (!rawMeta || rawMeta.schemaVersion !== 1 || !rawMeta.sourceRef || !rawMeta.packInfo) continue

    const parsedPack = PackSchema.safeParse(rawMeta.packInfo)
    if (!parsedPack.success) continue
    const info = parsedPack.data

    const view: PackView = {
      key: packKey,
      id: info.id,
      source: {
        repo: rawMeta.sourceRef.repo,
        branch: rawMeta.sourceRef.branch,
        official: Boolean(rawMeta.sourceRef.official)
      },
      name: info.name,
      summary: info.summary,
      description: info.description,
      coverDataUrl: rawMeta.coverDataUrl ?? null,
      version: installedVersion,
      minecraft: info.minecraft,
      loader: info.loader,
      recommendedMemoryMb: info.recommendedMemoryMb,
      minMemoryMb: info.minMemoryMb ?? null,
      server: info.server ?? null,
      installedVersion,
      status: 'ready',
      lastError: null,
      conflicts: [],
      warnings: []
    }
    out.push({ view, sourceRef: rawMeta.sourceRef, packInfo: info })
  }
  return out
}

export class CatalogService {
  private readonly loaded = new Map<string, LoadedPackEntry>()

  constructor(private readonly userDataDir: string) {}

  getEntry(packKey: string): LoadedPackEntry | undefined {
    return this.loaded.get(packKey)
  }

  getAllEntries(): LoadedPackEntry[] {
    return [...this.loaded.values()]
  }

  async loadCatalog(
    settings: Settings,
    opts?: CatalogRequestOptions
  ): Promise<CatalogResult> {
    const cacheDir = join(this.userDataDir, 'cache')
    const cachePath = join(cacheDir, 'catalog-cache.json')
    const sources: PackSourceRef[] = []
    const seenSource = new Set<string>()
    let catalogError: string | null = null

    const pushSource = (ref: PackSourceRef) => {
      const k = `${ref.repo.toLowerCase()}::${ref.branch}::${ref.path}`
      if (seenSource.has(k)) return
      seenSource.add(k)
      sources.push(ref)
    }

    if (settings.catalogUrl.trim()) {
      try {
        const raw = await fetchJsonSafe(settings.catalogUrl.trim(), opts)
        const parsed = CatalogSchema.safeParse(raw)
        if (!parsed.success) {
          catalogError = `Некорректный каталог сборок: ${formatZodError(parsed.error)}`
        } else {
          for (const entry of parsed.data.packs) {
            pushSource({
              repo: entry.repo,
              branch: entry.branch,
              path: entry.path,
              official: true
            })
          }
        }
      } catch (e) {
        if (isAbortError(e)) throw e
        catalogError = e instanceof LauncherError ? `${e.title}: ${e.message}` : String(e)
        log.warn('Не удалось загрузить официальный каталог', e)
      }
    }

    for (const custom of settings.customRepos) {
      pushSource({
        repo: custom.repo,
        branch: custom.branch,
        path: custom.path,
        official: false
      })
    }

    const errors: PackLoadError[] = []
    const packs: PackView[] = []
    const cacheEntries: CatalogCacheFile['packs'] = []
    const seenPackKeys = new Set<string>()

    for (const src of sources) {
      try {
        const infos = await fetchPackInfosFromRepo(src, opts)
        for (const info of infos) {
          const packKey = makePackKey(src.repo, info.id)
          if (seenPackKeys.has(packKey)) continue
          seenPackKeys.add(packKey)

          const installedVersion = await readInstalledPackVersion(settings.installDir, packKey)
          const coverDataUrl = await loadCoverDataUrl(src, info.cover, cacheDir, opts)
          const status: PackStatus = !installedVersion
            ? 'not-installed'
            : installedVersion === info.version
              ? 'ready'
              : 'update-available'

          const sourceRef: PackSourceRef = {
            ...src,
            packId: info.id,
            newsPath: info.news
          }

          const view: PackView = {
            key: packKey,
            id: info.id,
            source: { repo: src.repo, branch: src.branch, official: src.official },
            name: info.name,
            summary: info.summary,
            description: info.description,
            coverDataUrl,
            version: info.version,
            minecraft: info.minecraft,
            loader: info.loader,
            recommendedMemoryMb: info.recommendedMemoryMb,
            minMemoryMb: info.minMemoryMb ?? null,
            server: info.server ?? null,
            installedVersion,
            status,
            lastError: null,
            conflicts: [],
            warnings: []
          }

          packs.push(view)
          this.loaded.set(packKey, { view, sourceRef, packInfo: info })
          if (installedVersion) {
            await saveLocalPackMeta(join(settings.installDir, 'instances', packKey), {
              schemaVersion: 1,
              packKey,
              sourceRef,
              packInfo: info,
              coverDataUrl
            }).catch(() => undefined)
          }
          cacheEntries.push({
            ...view,
            sourceRef,
            manifestUrl: info.manifestUrl,
            newsPath: info.news
          })
        }
      } catch (e) {
        if (isAbortError(e)) throw e
        const msg = e instanceof LauncherError ? `${e.title}: ${e.message}` : String(e)
        errors.push({ repo: src.repo, message: msg })
        log.warn(`Ошибка загрузки сборки из ${src.repo}`, e)
      }
    }

    const loadedAt = new Date().toISOString()

    // Если сеть недоступна — восстанавливаем витрину из кэша и установленных сборок (офлайн-режим).
    if (packs.length === 0 && (catalogError || errors.length > 0)) {
      const restored: PackView[] = []
      const restoredKeys = new Set<string>()
      const cached = await readJsonFile<CatalogCacheFile>(cachePath).catch(() => null)
      if (cached && Array.isArray(cached.packs)) {
        for (const item of cached.packs) {
          const installedVersion = await readInstalledPackVersion(settings.installDir, item.key)
          const status: PackStatus = installedVersion ? 'ready' : 'not-installed'
          const view: PackView = {
            key: item.key,
            id: item.id,
            source: item.source,
            name: item.name,
            summary: item.summary,
            description: item.description,
            coverDataUrl: item.coverDataUrl,
            version: item.version,
            minecraft: item.minecraft,
            loader: item.loader,
            recommendedMemoryMb: item.recommendedMemoryMb,
            minMemoryMb: item.minMemoryMb,
            server: item.server,
            installedVersion,
            status,
            lastError: null,
            conflicts: [],
            warnings: []
          }
          restored.push(view)
          restoredKeys.add(item.key)
          this.loaded.set(item.key, {
            view,
            sourceRef: item.sourceRef,
            packInfo: {
              schemaVersion: 1,
              id: item.id,
              name: item.name,
              summary: item.summary,
              description: item.description,
              version: item.version,
              minecraft: item.minecraft,
              loader: item.loader,
              recommendedMemoryMb: item.recommendedMemoryMb,
              minMemoryMb: item.minMemoryMb ?? undefined,
              manifestUrl: item.manifestUrl,
              server: item.server ?? undefined,
              news: item.newsPath
            }
          })
        }
      }

      const localInstalled = await scanLocalInstalledPacks(settings.installDir, getUrlValidator(opts))
      for (const local of localInstalled) {
        if (restoredKeys.has(local.view.key)) continue
        restored.push(local.view)
        restoredKeys.add(local.view.key)
        this.loaded.set(local.view.key, local)
      }

      if (restored.length > 0) {
        return {
          packs: restored,
          errors,
          fromCache: true,
          catalogError:
            catalogError ??
            'GitHub недоступен. Показаны сохранённые сборки — установленные сборки доступны для запуска в офлайн-режиме.',
          loadedAt: cached?.loadedAt ?? loadedAt
        }
      }
    }

    if (cacheEntries.length > 0) {
      await ensureDir(cacheDir)
      await writeJsonAtomic(cachePath, { loadedAt, packs: cacheEntries }).catch(() => undefined)
    }

    return {
      packs,
      errors,
      fromCache: false,
      catalogError,
      loadedAt
    }
  }

  /**
   * Строгая онлайн-проверка pack.json + manifest.json без использования кэша.
   * Обязательна перед установкой и перед каждым запуском игры.
   */
  async fetchPackAndManifest(
    source: PackSourceRef,
    opts?: CatalogRequestOptions
  ): Promise<{ pack: PackInfo; manifest: Manifest }> {
    const validator = getUrlValidator(opts)
    const infos = await fetchPackInfosFromRepo(source, opts)
    const pack = source.packId ? infos.find((i) => i.id === source.packId) : infos[0]
    if (!pack) {
      throw new LauncherError(
        'pack-mismatch',
        'Сборка не найдена в репозитории',
        `В репозитории ${source.repo} не найдена сборка «${source.packId ?? ''}».`
      )
    }

    const rawManifest = await fetchJsonSafe(pack.manifestUrl, opts, 64 * 1024 * 1024)
    const ManifestValidator = createManifestSchema(validator)
    const parsedManifest = ManifestValidator.safeParse(rawManifest)
    if (!parsedManifest.success) {
      throw new LauncherError(
        'manifest-invalid',
        'Некорректный манифест сборки',
        `Манифест ${pack.manifestUrl} не прошёл проверку схемы: ${formatZodError(parsedManifest.error)}`
      )
    }

    const manifest = parsedManifest.data
    if (manifest.packId !== pack.id) {
      throw new LauncherError(
        'pack-mismatch',
        'Несовпадение сборки и манифеста',
        `Манифест относится к сборке «${manifest.packId}», а ожидалась «${pack.id}».`
      )
    }
    if (manifest.minecraft !== pack.minecraft || manifest.loader.type !== pack.loader.type) {
      throw new LauncherError(
        'pack-mismatch',
        'Несовпадение параметров сборки',
        `Манифест описывает Minecraft ${manifest.minecraft} (${manifest.loader.type}), а в описании указано ${pack.minecraft} (${pack.loader.type}).`
      )
    }
    if (
      manifest.loader.type !== 'vanilla' &&
      pack.loader.type !== 'vanilla' &&
      manifest.loader.version !== pack.loader.version
    ) {
      throw new LauncherError(
        'pack-mismatch',
        'Несовпадение версии загрузчика',
        `Манифест требует ${manifest.loader.type} ${manifest.loader.version}, а в описании указано ${pack.loader.version}.`
      )
    }

    return { pack, manifest }
  }

  async loadNews(
    entries: LoadedPackEntry[],
    opts?: CatalogRequestOptions
  ): Promise<NewsResult> {
    const validator = getUrlValidator(opts)
    const LegacySchema = createLegacyLauncherIndexSchema(validator)
    const items: NewsItemView[] = []
    const errors: PackLoadError[] = []
    const loadedSources = new Map<string, News>()

    for (const entry of entries) {
      const newsRel = entry.sourceRef.newsPath ?? entry.packInfo.news ?? 'ForLauncher/news.json'
      const cacheKey = `${entry.sourceRef.repo}::${entry.sourceRef.branch}::${newsRel}`
      let newsData = loadedSources.get(cacheKey)

      if (!newsData) {
        const candidates =
          newsRel === 'ForLauncher/news.json'
            ? ['ForLauncher/news.json', 'launcher/news.json', 'launcher-index.json']
            : newsRel === 'launcher/news.json'
              ? ['launcher/news.json', 'ForLauncher/news.json', 'launcher-index.json']
              : [newsRel]

        let non404Err: unknown = null
        for (const candidatePath of candidates) {
          const url = getRawUrl(entry.sourceRef, candidatePath, opts)
          try {
            const raw = await fetchJsonSafe(url, opts, 4 * 1024 * 1024)
            if (candidatePath === 'launcher-index.json') {
              const parsedLegacy = LegacySchema.safeParse(raw)
              if (!parsedLegacy.success) {
                throw new LauncherError('manifest-invalid', 'Ошибка формата новостей', formatZodError(parsedLegacy.error))
              }
              newsData = legacyIndexToNews(parsedLegacy.data)
            } else {
              const parsed = NewsSchema.safeParse(raw)
              if (parsed.success) {
                newsData = parsed.data
              } else {
                const fallbackLegacy = LegacySchema.safeParse(raw)
                if (!fallbackLegacy.success) {
                  throw new LauncherError('manifest-invalid', 'Ошибка формата новостей', formatZodError(parsed.error))
                }
                newsData = legacyIndexToNews(fallbackLegacy.data)
              }
            }
            loadedSources.set(cacheKey, newsData)
            break
          } catch (e) {
            if (isAbortError(e)) throw e
            if (isNotFoundError(e)) continue
            non404Err = e
            break
          }
        }
        if (!newsData) {
          if (non404Err) {
            const msg = non404Err instanceof LauncherError ? `${non404Err.title}: ${non404Err.message}` : String(non404Err)
            errors.push({ repo: entry.sourceRef.repo, message: msg })
          }
          continue
        }
      }

      for (const n of newsData.items) {
        items.push({
          id: `${entry.view.key}:${n.id}`,
          date: n.date,
          title: n.title,
          body: n.body,
          packVersion: n.packVersion ?? null,
          packKey: entry.view.key,
          packName: entry.view.name
        })
      }
    }

    items.sort((a, b) => b.date.localeCompare(a.date))
    return { items, errors }
  }
}
