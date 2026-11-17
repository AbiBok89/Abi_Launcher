import { createHash, randomUUID } from 'node:crypto'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { Profile, ProfilesState, Settings } from '@shared/types'
import { checkRelativePath } from '@shared/paths'
import { LauncherError } from './errors'
import { checkWritable, readJsonFile, writeJsonAtomic } from './fsutil'
import { normalizeCatalogUrl } from './github'

export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/AbiBok89/Abi_Launcher/main/catalog/catalog.json'
export const DEFAULT_CUSTOM_REPOS = [
  { repo: 'AbiBok89/abi_tfg', branch: 'main', path: 'launcher/pack.json' }
]

const NICKNAME_RE = /^[A-Za-z0-9_]{3,16}$/

export function totalSystemMemoryMb(): number {
  return Math.max(2048, Math.floor(totalmem() / (1024 * 1024)))
}

export function computeDefaultMemoryMb(totalMb = totalSystemMemoryMb()): number {
  const half = Math.floor(totalMb / 2)
  const rounded = Math.round(half / 512) * 512
  return Math.max(2048, Math.min(8192, rounded))
}

/**
 * Генерирует offline UUID версии 3 (как Java `UUID.nameUUIDFromBytes("OfflinePlayer:<name>")`).
 */
export function offlineUuidFromName(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function validateNickname(raw: string): string {
  const name = raw.trim()
  if (!NICKNAME_RE.test(name)) {
    throw new LauncherError(
      'no-profile',
      'Некорректный никнейм',
      'Никнейм должен содержать от 3 до 16 символов: латинские буквы, цифры и знак подчёркивания (_).'
    )
  }
  return name
}

const CustomRepoSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
  branch: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).refine((v) => !v.includes('..')).default('main'),
  path: z
    .string()
    .refine((v) => checkRelativePath(v) === null)
    .default('launcher/pack.json')
})

const PackOverrideSchema = z.object({
  memoryMb: z.number().int().min(1024).max(65536).nullable().optional(),
  javaPath: z.string().max(1024).nullable().optional()
})

const SettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  installDir: z.string().min(1).max(1024),
  catalogUrl: z.string().max(2048),
  customRepos: z.array(CustomRepoSchema).max(100),
  defaultMemoryMb: z.number().int().min(1024).max(65536).nullable(),
  javaPath: z.string().max(1024).nullable(),
  resolution: z.object({
    width: z.number().int().min(640).max(7680),
    height: z.number().int().min(480).max(4320),
    fullscreen: z.boolean()
  }),
  afterLaunch: z.enum(['keep', 'minimize', 'hide', 'close']),
  fullVerifyOnLaunch: z.boolean(),
  autoJoinServer: z.boolean(),
  packOverrides: z.record(z.string().max(200), PackOverrideSchema)
})

const ProfileSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().regex(NICKNAME_RE),
  uuid: z.string().min(1).max(64),
  createdAt: z.string().min(1).max(64)
})

const ProfilesStateSchema = z.object({
  profiles: z.array(ProfileSchema).max(100),
  selectedId: z.string().nullable()
})

export function defaultSettings(userDataDir: string): Settings {
  return {
    theme: 'system',
    installDir: join(userDataDir, 'gamedata'),
    catalogUrl: DEFAULT_CATALOG_URL,
    customRepos: DEFAULT_CUSTOM_REPOS.map((r) => ({ ...r })),
    defaultMemoryMb: computeDefaultMemoryMb(),
    javaPath: null,
    resolution: { width: 1280, height: 720, fullscreen: false },
    afterLaunch: 'keep',
    fullVerifyOnLaunch: false,
    autoJoinServer: true,
    packOverrides: {}
  }
}

export class SettingsStore {
  private readonly filePath: string
  private cached: Settings | null = null

  constructor(private readonly userDataDir: string) {
    this.filePath = join(userDataDir, 'settings.json')
  }

  async load(): Promise<Settings> {
    if (this.cached) return structuredClone(this.cached)
    const defaults = defaultSettings(this.userDataDir)
    let raw: unknown = null
    try {
      raw = await readJsonFile<unknown>(this.filePath)
    } catch {
      raw = null
    }
    const merged = raw && typeof raw === 'object' ? { ...defaults, ...(raw as Record<string, unknown>) } : defaults
    const parsed = SettingsSchema.safeParse(merged)
    const normalized = parsed.success ? this.clampLimits(parsed.data) : defaults
    this.cached = normalized
    if (!raw || !parsed.success) {
      await writeJsonAtomic(this.filePath, normalized).catch(() => undefined)
    }
    return structuredClone(normalized)
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.load()
    const next: Settings = {
      ...current,
      ...patch,
      resolution: patch.resolution ? { ...current.resolution, ...patch.resolution } : current.resolution,
      packOverrides: patch.packOverrides ? { ...current.packOverrides, ...patch.packOverrides } : current.packOverrides
    }

    if (patch.catalogUrl !== undefined) {
      next.catalogUrl = normalizeCatalogUrl(patch.catalogUrl)
    }

    if (patch.installDir !== undefined) {
      const targetDir = resolve(patch.installDir.trim())
      if (!targetDir) {
        throw new LauncherError('filesystem', 'Некорректная папка', 'Укажите путь к папке установки.')
      }
      const writable = await checkWritable(targetDir)
      if (!writable) {
        throw new LauncherError(
          'filesystem',
          'Папка недоступна для записи',
          `Лаунчер не может создавать файлы в папке «${targetDir}».`,
          'Выберите другую папку, например в каталоге пользователя.'
        )
      }
      next.installDir = targetDir
    }

    if (patch.javaPath !== undefined) {
      next.javaPath = patch.javaPath ? patch.javaPath.trim() : null
    }

    const totalMb = totalSystemMemoryMb()
    if (next.defaultMemoryMb !== null) {
      if (!Number.isInteger(next.defaultMemoryMb) || next.defaultMemoryMb < 1024 || next.defaultMemoryMb > totalMb) {
        throw new LauncherError(
          'unknown',
          'Некорректный объём памяти',
          `Укажите значение от 1024 до ${totalMb} МБ.`
        )
      }
    }

    for (const [key, ov] of Object.entries(next.packOverrides)) {
      if (ov.memoryMb !== undefined && ov.memoryMb !== null) {
        if (!Number.isInteger(ov.memoryMb) || ov.memoryMb < 1024 || ov.memoryMb > totalMb) {
          throw new LauncherError(
            'unknown',
            'Некорректный объём памяти для сборки',
            `Для сборки «${key}» укажите от 1024 до ${totalMb} МБ.`
          )
        }
      }
    }

    const validated = SettingsSchema.safeParse(next)
    if (!validated.success) {
      throw new LauncherError(
        'unknown',
        'Некорректные настройки',
        validated.error.issues.map((i) => `${i.path.join('.') || 'настройки'}: ${i.message}`).join('; ')
      )
    }

    const clamped = this.clampLimits(validated.data)
    this.cached = clamped
    await writeJsonAtomic(this.filePath, clamped)
    return structuredClone(clamped)
  }

  private clampLimits(settings: Settings): Settings {
    const totalMb = totalSystemMemoryMb()
    const clampMem = (m: number | null | undefined) =>
      m === null || m === undefined ? m : Math.max(1024, Math.min(totalMb, m))
    const packOverrides: Settings['packOverrides'] = {}
    for (const [k, v] of Object.entries(settings.packOverrides)) {
      packOverrides[k] = {
        memoryMb: clampMem(v.memoryMb),
        javaPath: v.javaPath ?? null
      }
    }
    return {
      ...settings,
      defaultMemoryMb: clampMem(settings.defaultMemoryMb) ?? null,
      packOverrides
    }
  }
}

export class ProfileStore {
  private readonly filePath: string
  private state: ProfilesState | null = null

  constructor(private readonly userDataDir: string) {
    this.filePath = join(userDataDir, 'profiles.json')
  }

  async load(): Promise<ProfilesState> {
    if (this.state) return structuredClone(this.state)
    let raw: unknown = null
    try {
      raw = await readJsonFile<unknown>(this.filePath)
    } catch {
      raw = null
    }
    const parsed = ProfilesStateSchema.safeParse(raw)
    if (parsed.success) {
      const hasSelected = parsed.data.profiles.some((p) => p.id === parsed.data.selectedId)
      this.state = {
        profiles: parsed.data.profiles,
        selectedId: hasSelected ? parsed.data.selectedId : (parsed.data.profiles[0]?.id ?? null)
      }
    } else {
      this.state = { profiles: [], selectedId: null }
    }
    return structuredClone(this.state)
  }

  async createProfile(rawName: string): Promise<ProfilesState> {
    const name = validateNickname(rawName)
    const state = await this.load()
    if (state.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new LauncherError('no-profile', 'Профиль уже существует', `Профиль с ником «${name}» уже добавлен.`)
    }
    const profile: Profile = {
      id: randomUUID(),
      name,
      uuid: offlineUuidFromName(name),
      createdAt: new Date().toISOString()
    }
    const next: ProfilesState = {
      profiles: [...state.profiles, profile],
      selectedId: profile.id
    }
    return this.save(next)
  }

  async renameProfile(id: string, rawName: string): Promise<ProfilesState> {
    const name = validateNickname(rawName)
    const state = await this.load()
    const target = state.profiles.find((p) => p.id === id)
    if (!target) {
      throw new LauncherError('no-profile', 'Профиль не найден', 'Выбранный профиль не найден.')
    }
    if (state.profiles.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) {
      throw new LauncherError('no-profile', 'Никнейм занят', `Профиль с ником «${name}» уже существует.`)
    }
    const next: ProfilesState = {
      ...state,
      profiles: state.profiles.map((p) =>
        p.id === id ? { ...p, name, uuid: offlineUuidFromName(name) } : p
      )
    }
    return this.save(next)
  }

  async deleteProfile(id: string): Promise<ProfilesState> {
    const state = await this.load()
    const profiles = state.profiles.filter((p) => p.id !== id)
    const selectedId =
      state.selectedId === id ? (profiles[0]?.id ?? null) : state.selectedId
    return this.save({ profiles, selectedId })
  }

  async selectProfile(id: string): Promise<ProfilesState> {
    const state = await this.load()
    if (!state.profiles.some((p) => p.id === id)) {
      throw new LauncherError('no-profile', 'Профиль не найден', 'Не удалось выбрать профиль.')
    }
    return this.save({ ...state, selectedId: id })
  }

  async getSelectedProfile(): Promise<Profile | null> {
    const state = await this.load()
    return state.profiles.find((p) => p.id === state.selectedId) ?? null
  }

  private async save(next: ProfilesState): Promise<ProfilesState> {
    this.state = next
    await writeJsonAtomic(this.filePath, next)
    return structuredClone(next)
  }
}
