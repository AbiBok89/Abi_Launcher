import { z } from 'zod'
import { checkRelativePath } from './paths'

/**
 * Схемы удалённых JSON-файлов (каталог, описание сборки, манифест, новости).
 * Любой ответ GitHub проходит через эти схемы до использования.
 */

/** Хосты, с которых разрешено скачивать файлы сборок, обложки и метаданные. */
export const ALLOWED_DOWNLOAD_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'cdn.modrinth.com'
] as const

export type UrlValidator = (value: string) => boolean

export function isAllowedUrl(value: string): boolean {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    return (ALLOWED_DOWNLOAD_HOSTS as readonly string[]).includes(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

function makeHttpsUrl(check: UrlValidator = isAllowedUrl) {
  return z
    .string()
    .max(2048)
    .refine(check, { message: 'ссылка должна быть https:// на разрешённый хост (GitHub, Modrinth CDN)' })
}

const httpsUrl = makeHttpsUrl()

const relPath = z.string().superRefine((v, ctx) => {
  const err = checkRelativePath(v)
  if (err) ctx.addIssue({ code: 'custom', message: `небезопасный путь «${v}»: ${err}` })
})

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'ожидается SHA-256 в нижнем регистре (64 hex-символа)')
const packId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'id: латиница в нижнем регистре, цифры, . _ -')
const mcVersion = z.string().regex(/^[0-9A-Za-z._-]{1,32}$/)
const loaderVersion = z.string().regex(/^[0-9A-Za-z._+-]{1,64}$/)
const repoSlug = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'ожидается owner/repo')
const branch = z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).refine((v) => !v.includes('..'))

export const LoaderSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vanilla') }),
  z.object({ type: z.literal('fabric'), version: loaderVersion }),
  z.object({ type: z.literal('forge'), version: loaderVersion }),
  z.object({ type: z.literal('neoforge'), version: loaderVersion })
])
export type Loader = z.infer<typeof LoaderSchema>
export type LoaderType = Loader['type']

export const ServerRefSchema = z.object({
  name: z.string().min(1).max(80),
  host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'хост сервера: домен или IPv4'),
  port: z.number().int().min(1).max(65535).optional()
})
export type ServerRef = z.infer<typeof ServerRefSchema>

/** catalog/catalog.json — список официальных сборок. */
export const CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().max(80).optional(),
  packs: z
    .array(
      z.object({
        repo: repoSlug,
        branch: branch.default('main'),
        path: relPath.default('ForLauncher/pack.json')
      })
    )
    .max(100)
})
export type Catalog = z.infer<typeof CatalogSchema>

export function createPackInfoSchema(urlCheck: UrlValidator = isAllowedUrl) {
  const urlSchema = makeHttpsUrl(urlCheck)
  return z.object({
    schemaVersion: z.literal(1),
    id: packId,
    name: z.string().min(1).max(80),
    summary: z.string().max(200).default(''),
    description: z.string().max(5000).default(''),
    /** Относительный путь в репозитории или https-ссылка на картинку (png/jpg/webp). */
    cover: z.union([relPath, urlSchema]).optional(),
    version: z.string().min(1).max(40),
    minecraft: mcVersion,
    loader: LoaderSchema,
    recommendedMemoryMb: z.number().int().min(1024).max(65536).default(8192),
    minMemoryMb: z.number().int().min(512).max(65536).optional(),
    manifestUrl: urlSchema,
    server: ServerRefSchema.optional(),
    /** Относительный путь к news.json в репозитории сборки. */
    news: relPath.default('ForLauncher/news.json')
  })
}

/** ForLauncher/pack.json в репозитории сборки — витрина сборки. */
export const PackInfoSchema = createPackInfoSchema()
export type PackInfo = z.infer<typeof PackInfoSchema>

export const FileModeSchema = z.enum(['managed', 'initial'])
export type FileMode = z.infer<typeof FileModeSchema>

export type ManifestFileSource =
  | { url: string }
  | { archive: string; entry: string }

export interface ManifestFile {
  path: string
  size: number
  sha256: string
  mode: FileMode
  required: boolean
  source: ManifestFileSource
}

export function createManifestFileSchema(urlCheck: UrlValidator = isAllowedUrl) {
  const urlSchema = makeHttpsUrl(urlCheck)
  const sourceSchema = z.union([
    z.object({ url: urlSchema }).strict(),
    z.object({ archive: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), entry: relPath }).strict()
  ])
  return z
    .object({
      path: relPath,
      size: z.number().int().min(0).max(4 * 1024 ** 3),
      sha256,
      /**
       * managed — файл контролируется лаунчером и обновляется вместе со сборкой;
       * initial — кладётся только если отсутствует (например options.txt), дальше принадлежит игроку.
       */
      mode: FileModeSchema.default('managed'),
      /** Обязательный файл нельзя оставить в изменённом виде: конфликт блокирует запуск. */
      required: z.boolean().default(true),
      source: sourceSchema.optional(),
      url: urlSchema.optional()
    })
    .superRefine((item, ctx) => {
      if (!item.source && !item.url) {
        ctx.addIssue({ code: 'custom', message: `файл «${item.path}»: требуется source или url` })
      }
      if (item.source && item.url) {
        ctx.addIssue({ code: 'custom', message: `файл «${item.path}»: укажите либо source, либо url` })
      }
    })
    .transform((item): ManifestFile => ({
      path: item.path,
      size: item.size,
      sha256: item.sha256,
      mode: item.mode,
      required: item.required,
      source: item.source ?? { url: item.url! }
    }))
}

export const ManifestFileSchema = createManifestFileSchema()

export function createManifestArchiveSchema(urlCheck: UrlValidator = isAllowedUrl) {
  const urlSchema = makeHttpsUrl(urlCheck)
  return z.object({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    url: urlSchema,
    size: z.number().int().min(1).max(2 * 1024 ** 3),
    sha256
  })
}

export const ManifestArchiveSchema = createManifestArchiveSchema()
export type ManifestArchive = z.infer<typeof ManifestArchiveSchema>

export function createManifestSchema(urlCheck: UrlValidator = isAllowedUrl) {
  return z
    .object({
      schemaVersion: z.literal(1),
      packId,
      version: z.string().min(1).max(40),
      createdAt: z.string().max(40).optional(),
      minecraft: mcVersion,
      loader: LoaderSchema,
      java: z.object({ major: z.number().int().min(8).max(99) }).optional(),
      archives: z.array(createManifestArchiveSchema(urlCheck)).max(1000).default([]),
      files: z.array(createManifestFileSchema(urlCheck)).max(200_000)
    })
    .superRefine((m, ctx) => {
      const seen = new Set<string>()
      for (const f of m.files) {
        const key = f.path.normalize('NFC').toLowerCase()
        if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `дубликат пути «${f.path}»` })
        seen.add(key)
        if ('archive' in f.source && !m.archives.some((a) => a.id === (f.source as { archive: string }).archive)) {
          ctx.addIssue({ code: 'custom', message: `файл «${f.path}» ссылается на неизвестный архив` })
        }
      }
      // Файл не может одновременно быть файлом и каталогом (a/b и a/b/c).
      for (const f of m.files) {
        const parts = f.path.split('/')
        for (let i = 1; i < parts.length; i++) {
          if (seen.has(parts.slice(0, i).join('/').normalize('NFC').toLowerCase())) {
            ctx.addIssue({ code: 'custom', message: `путь «${f.path}» конфликтует с файлом-родителем` })
            break
          }
        }
      }
    })
}

/** manifest.json — точный состав версии сборки. */
export const ManifestSchema = createManifestSchema()
export type Manifest = z.infer<typeof ManifestSchema>

export const NewsSchema = z.object({
  schemaVersion: z.literal(1),
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате ГГГГ-ММ-ДД'),
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).default(''),
        packVersion: z.string().max(40).optional()
      })
    )
    .max(200)
})
export type News = z.infer<typeof NewsSchema>

const legacyDate = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/, 'дата в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ')

export function createLegacyLauncherIndexSchema(urlCheck: UrlValidator = isAllowedUrl) {
  const urlSchema = makeHttpsUrl(urlCheck)
  return z.object({
    news: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          date: legacyDate,
          title: z.string().min(1).max(200),
          content: z.string().max(10_000).optional(),
          body: z.string().max(10_000).optional(),
          packVersion: z.string().max(40).optional()
        })
      )
      .max(200)
      .default([]),
    modpacks: z
      .array(
        z.object({
          id: packId,
          name: z.string().min(1).max(80),
          version: z.string().min(1).max(40),
          minecraftVersion: mcVersion,
          loader: LoaderSchema,
          javaVersion: z.number().int().min(8).max(99).optional(),
          serverAddress: z.string().max(260).optional(),
          backgroundUrl: z.union([relPath, urlSchema]).optional(),
          description: z.string().max(5000).default(''),
          summary: z.string().max(200).optional(),
          recommendedMemoryMb: z.number().int().min(1024).max(65536).default(8192),
          minMemoryMb: z.number().int().min(512).max(65536).optional(),
          manifestUrl: urlSchema
        })
      )
      .min(1)
      .max(50)
  })
}

/** Формат launcher-index.json (совместимость с AbiBok89/abi_tfg). */
export const LegacyLauncherIndexSchema = createLegacyLauncherIndexSchema()
export type LegacyLauncherIndex = z.infer<typeof LegacyLauncherIndexSchema>

function parseServerAddress(name: string, address?: string): ServerRef | undefined {
  if (!address) return undefined
  const trimmed = address.trim()
  if (!trimmed) return undefined
  const idx = trimmed.lastIndexOf(':')
  let host = trimmed
  let port: number | undefined
  if (idx > 0) {
    const candidatePort = Number(trimmed.slice(idx + 1))
    if (Number.isInteger(candidatePort) && candidatePort >= 1 && candidatePort <= 65535) {
      host = trimmed.slice(0, idx)
      port = candidatePort
    }
  }
  const parsed = ServerRefSchema.safeParse({ name, host, port })
  return parsed.success ? parsed.data : undefined
}

function normalizeLegacyDate(dateStr: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dateStr)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  return dateStr
}

export function legacyIndexToPackInfos(index: LegacyLauncherIndex): PackInfo[] {
  return index.modpacks.map((m) => ({
    schemaVersion: 1,
    id: m.id,
    name: m.name,
    summary: m.summary ?? (m.description.length > 160 ? m.description.slice(0, 157) + '...' : m.description),
    description: m.description,
    cover: m.backgroundUrl,
    version: m.version,
    minecraft: m.minecraftVersion,
    loader: m.loader,
    recommendedMemoryMb: m.recommendedMemoryMb,
    minMemoryMb: m.minMemoryMb,
    manifestUrl: m.manifestUrl,
    server: parseServerAddress(m.name, m.serverAddress),
    news: 'launcher-index.json'
  }))
}

export function legacyIndexToNews(index: LegacyLauncherIndex): News {
  return {
    schemaVersion: 1,
    items: index.news.map((n) => ({
      id: n.id,
      date: normalizeLegacyDate(n.date),
      title: n.title,
      body: n.body ?? n.content ?? '',
      packVersion: n.packVersion
    }))
  }
}

/** Понятный текст ошибки zod для пользователя. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'корень'}: ${i.message}`)
    .join('; ')
}
