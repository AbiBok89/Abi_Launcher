import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createFabricInstallWorkflow,
  createModernForgeInstallWorkflow,
  resolveForgeArtifactVersion
} from '@xmcl/installer'
import { buildDiagnosticsReport } from '@core/diagnostics'
import { supportsLegacyServerArg, supportsQuickPlay } from '@core/gameLauncher'
import { requiredJavaMajor } from '@core/javaManager'
import { logger } from '@core/log'
import { pingMinecraftServer } from '@core/serverPing'
import {
  ProfileStore,
  SettingsStore,
  defaultSettings,
  offlineUuidFromName,
  validateNickname
} from '@core/storage'
import { ManifestSchema } from '@shared/schemas'
import { buildPackRelease } from '../tools/publish/build-manifest'

function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let temp = v & 0x7f
    v >>>= 7
    if (v !== 0) temp |= 0x80
    bytes.push(temp)
  } while (v !== 0)
  return Buffer.from(bytes)
}

describe('Профили, настройки, пинг сервера, диагностика, загрузчики и публикация', () => {
  let tmpRoot: string

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'abi-services-'))
  })

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('управляет локальными профилями, валидирует никнеймы и детерминированно считает offline UUID', async () => {
    expect(() => validateNickname('ab')).toThrow()
    expect(() => validateNickname('игрок')).toThrow()
    expect(() => validateNickname('very_long_minecraft_name')).toThrow()
    expect(validateNickname('  Abi_Player1  ')).toBe('Abi_Player1')

    const u1 = offlineUuidFromName('Abi_Player1')
    const u2 = offlineUuidFromName('Abi_Player1')
    expect(u1).toBe(u2)
    expect(u1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    const store = new ProfileStore(join(tmpRoot, 'profiles-dir'))
    const s1 = await store.createProfile('PlayerOne')
    expect(s1.profiles).toHaveLength(1)
    expect(s1.selectedId).toBe(s1.profiles[0].id)

    const s2 = await store.createProfile('PlayerTwo')
    expect(s2.profiles).toHaveLength(2)
    expect(s2.selectedId).toBe(s2.profiles[1].id)

    const s3 = await store.renameProfile(s1.profiles[0].id, 'PlayerOneNew')
    expect(s3.profiles[0].name).toBe('PlayerOneNew')
    expect(s3.profiles[0].uuid).toBe(offlineUuidFromName('PlayerOneNew'))

    const s4 = await store.deleteProfile(s2.profiles[1].id)
    expect(s4.profiles).toHaveLength(1)
    expect(s4.selectedId).toBe(s1.profiles[0].id)
  })

  it('сохраняет настройки и проверяет корректность путей и памяти', async () => {
    const dataDir = join(tmpRoot, 'settings-dir')
    const customGameDir = join(tmpRoot, 'Мои сборки Minecraft')
    const store = new SettingsStore(dataDir)
    const def = await store.load()
    expect(def.theme).toBe('system')

    const updated = await store.update({
      theme: 'dark',
      installDir: customGameDir,
      resolution: { width: 1920, height: 1080, fullscreen: false }
    })
    expect(updated.installDir).toBe(customGameDir)
    expect(updated.theme).toBe('dark')

    await expect(store.update({ defaultMemoryMb: 256 })).rejects.toThrow()
  })

  it('опрашивает статус Minecraft-сервера по TCP (Server List Ping)', async () => {
    const payloadJson = JSON.stringify({
      version: { name: '1.20.1 Forge', protocol: 763 },
      players: { max: 20, online: 3 },
      description: { text: '§aПривет, ', extra: [{ text: '§lДрузья!' }] }
    })
    const jsonBuf = Buffer.from(payloadJson, 'utf8')
    const body = Buffer.concat([Buffer.from([0x00]), writeVarInt(jsonBuf.length), jsonBuf])
    const packet = Buffer.concat([writeVarInt(body.length), body])

    const tcpServer = createServer((socket) => {
      socket.once('data', () => {
        socket.write(packet)
      })
    })
    await new Promise<void>((res) => tcpServer.listen(0, '127.0.0.1', () => res()))
    const port = (tcpServer.address() as { port: number }).port

    try {
      const ok = await pingMinecraftServer('127.0.0.1', port)
      expect(ok.online).toBe(true)
      expect(ok.playersOnline).toBe(3)
      expect(ok.playersMax).toBe(20)
      expect(ok.version).toBe('1.20.1 Forge')
      expect(ok.motd).toBe('Привет, Друзья!')

      const closed = await pingMinecraftServer('127.0.0.1', 1, 800)
      expect(closed.online).toBe(false)
      expect(closed.error).toBeTruthy()
    } finally {
      await new Promise<void>((res) => tcpServer.close(() => res()))
    }
  })

  it('корректно выбирает версию Java, аргументы автоподключения и поддерживает API Fabric/Forge/NeoForge', () => {
    expect(requiredJavaMajor('1.12.2')).toBe(8)
    expect(requiredJavaMajor('1.16.5')).toBe(8)
    expect(requiredJavaMajor('1.19.2')).toBe(17)
    expect(requiredJavaMajor('1.20.1')).toBe(17)
    expect(requiredJavaMajor('1.20.5')).toBe(21)
    expect(requiredJavaMajor('1.21.1')).toBe(21)

    expect(supportsQuickPlay('1.20.1')).toBe(true)
    expect(supportsQuickPlay('1.21.4')).toBe(true)
    expect(supportsQuickPlay('1.19.2')).toBe(false)
    expect(supportsLegacyServerArg('1.19.2')).toBe(true)
    expect(supportsLegacyServerArg('1.12.2')).toBe(true)

    expect(resolveForgeArtifactVersion('1.20.1', '47.4.13')).toBe('1.20.1-47.4.13')
    expect(typeof createFabricInstallWorkflow).toBe('function')
    expect(typeof createModernForgeInstallWorkflow).toBe('function')
  })

  it('генерирует валидный релиз и manifest.json через buildPackRelease, исключая личные папки', async () => {
    const srcPack = join(tmpRoot, 'src-modpack')
    const outPack = join(tmpRoot, 'out-modpack')
    await mkdir(join(srcPack, 'mods'), { recursive: true })
    await mkdir(join(srcPack, 'config'), { recursive: true })
    await mkdir(join(srcPack, 'saves/myworld'), { recursive: true })

    await writeFile(join(srcPack, 'mods/big-mod.jar'), Buffer.alloc(4096, 0x7a))
    await writeFile(join(srcPack, 'config/client.toml'), 'setting = true\n')
    await writeFile(join(srcPack, 'options.txt'), 'fov:80\n')
    await writeFile(join(srcPack, 'saves/myworld/level.dat'), 'secret-save')

    const built = await buildPackRelease({
      sourceDir: srcPack,
      outDir: outPack,
      packId: 'demo-pack',
      name: 'Demo Pack',
      version: '1.0.0',
      minecraft: '1.20.1',
      loader: { type: 'forge', version: '47.4.13' },
      repo: 'AbiBok89/abi_tfg',
      releaseTag: 'v1.0.0',
      archiveThresholdBytes: 2048 // big-mod.jar (4KB) пойдёт отдельным ассетом, остальное в zip
    })

    expect(built.stats.totalFiles).toBe(3)
    expect(built.stats.directFiles).toBe(1)
    expect(built.stats.archivedFiles).toBe(2)
    expect(built.stats.archivesCount).toBe(1)

    const parsedManifest = ManifestSchema.parse(JSON.parse(await readFile(built.manifestPath, 'utf8')))
    expect(parsedManifest.files.some((f) => f.path.startsWith('saves/'))).toBe(false)
    expect(parsedManifest.files.find((f) => f.path === 'options.txt')?.mode).toBe('initial')
    expect(parsedManifest.files.find((f) => f.path === 'mods/big-mod.jar')?.source).toHaveProperty('url')
  })

  it('очищает диагностический отчёт от секретов и персональных данных', () => {
    logger.scope('test').info('Проверка пути и token=super_secret_12345')
    const s = defaultSettings(tmpRoot)
    const reportText = buildDiagnosticsReport({
      launcherVersion: '0.1.0',
      electronVersion: '45.0.0',
      nodeVersion: '26.0.0',
      settings: s,
      profilesCount: 2,
      packs: [],
      javaList: []
    })
    expect(reportText).not.toContain('super_secret_12345')
    expect(reportText).toContain('"profilesCount": 2')
  })
})
