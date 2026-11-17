import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { extractZipEntries } from '@core/archive'
import { CatalogService, makePackKey } from '@core/catalogService'
import { LauncherError } from '@core/errors'
import { sha256Text } from '@core/hash'
import { downloadVerified } from '@core/http'
import { applyPackSync, planPackSync, readPackState } from '@core/packUpdater'
import { defaultSettings } from '@core/storage'
import type { Manifest, PackInfo } from '@shared/schemas'

async function makeZipBuffer(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  for (const e of entries) zip.addBuffer(e.content, e.name)
  const chunks: Buffer[] = []
  zip.outputStream.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((res, rej) => {
    zip.outputStream.on('end', () => res())
    zip.outputStream.on('error', rej)
  })
  zip.end()
  await done
  return Buffer.concat(chunks)
}

describe('Обновление сборок, докачка, конфликты и защита пользовательских файлов', () => {
  let rootTemp: string
  let server: Server
  let baseUrl = ''
  const routes = new Map<string, Buffer>()
  const requestCounts = new Map<string, number>()
  let failPartialRouteOnce: string | null = null

  beforeAll(async () => {
    rootTemp = await mkdtemp(join(tmpdir(), 'AbiLauncher Тест Пробелы '))
    server = createServer((req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0]
      requestCounts.set(urlPath, (requestCounts.get(urlPath) ?? 0) + 1)

      const body = routes.get(urlPath)
      if (!body) {
        res.statusCode = 404
        res.end('Not found')
        return
      }

      if (failPartialRouteOnce === urlPath) {
        failPartialRouteOnce = null
        res.statusCode = 200
        res.setHeader('Content-Length', String(body.length))
        res.flushHeaders()
        const half = Math.floor(body.length / 2)
        res.write(body.subarray(0, half), () => {
          setTimeout(() => req.socket.destroy(), 20)
        })
        return
      }

      const rangeHeader = req.headers.range
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const start = Number(rangeHeader.slice('bytes='.length).split('-')[0])
        if (Number.isInteger(start) && start >= 0 && start < body.length) {
          const slice = body.subarray(start)
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${body.length - 1}/${body.length}`)
          res.setHeader('Content-Length', String(slice.length))
          res.end(slice)
          return
        }
      }

      res.statusCode = 200
      res.setHeader('Content-Length', String(body.length))
      res.end(body)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(rootTemp, { recursive: true, force: true })
  })

  const localOpts = () => ({
    isAllowed: (u: string) => u.startsWith(baseUrl),
    resolveRawUrl: (ref: { repo: string; branch: string }, p: string) =>
      `${baseUrl}/raw/${ref.repo}/${ref.branch}/${p}`
  })

  it('выполняет первую установку, повторный запуск без скачивания, обновление с сохранением личных файлов и разрешение конфликтов', async () => {
    const userDataDir = join(rootTemp, 'Профиль Данных')
    const installDir = join(rootTemp, 'Папка с пробелами и кириллицей', 'Игровые Сборки')
    const repo = 'TestOwner/PackRepo'
    const packKey = makePackKey(repo, 'test-pack')
    const instanceDir = join(installDir, 'instances', packKey)

    // Версия 1.0.0
    const modABuf = Buffer.from('mod-a-content-v1')
    const modOldBuf = Buffer.from('obsolete-mod-v1')
    const cfgRequiredBuf = Buffer.from('required-config-v1')
    const cfgOptionalBuf = Buffer.from('optional-config-v1')
    const optionsInitBuf = Buffer.from('lang:ru_ru\n')

    const zipV1 = await makeZipBuffer([
      { name: 'config/required.toml', content: cfgRequiredBuf },
      { name: 'config/optional.toml', content: cfgOptionalBuf },
      { name: 'options.txt', content: optionsInitBuf }
    ])

    const manifestV1: Manifest = {
      schemaVersion: 1,
      packId: 'test-pack',
      version: '1.0.0',
      minecraft: '1.20.1',
      loader: { type: 'fabric', version: '0.16.0' },
      archives: [
        {
          id: 'part-1',
          url: `${baseUrl}/rel/v1/part-1.zip`,
          size: zipV1.length,
          sha256: sha256Text(zipV1)
        }
      ],
      files: [
        {
          path: 'mods/mod-a.jar',
          size: modABuf.length,
          sha256: sha256Text(modABuf),
          mode: 'managed',
          required: true,
          source: { url: `${baseUrl}/rel/v1/mod-a.jar` }
        },
        {
          path: 'mods/mod-old.jar',
          size: modOldBuf.length,
          sha256: sha256Text(modOldBuf),
          mode: 'managed',
          required: true,
          source: { url: `${baseUrl}/rel/v1/mod-old.jar` }
        },
        {
          path: 'config/required.toml',
          size: cfgRequiredBuf.length,
          sha256: sha256Text(cfgRequiredBuf),
          mode: 'managed',
          required: true,
          source: { archive: 'part-1', entry: 'config/required.toml' }
        },
        {
          path: 'config/optional.toml',
          size: cfgOptionalBuf.length,
          sha256: sha256Text(cfgOptionalBuf),
          mode: 'managed',
          required: false,
          source: { archive: 'part-1', entry: 'config/optional.toml' }
        },
        {
          path: 'options.txt',
          size: optionsInitBuf.length,
          sha256: sha256Text(optionsInitBuf),
          mode: 'initial',
          required: false,
          source: { archive: 'part-1', entry: 'options.txt' }
        }
      ]
    }

    const packInfoV1: PackInfo = {
      schemaVersion: 1,
      id: 'test-pack',
      name: 'Тестовая сборка',
      summary: 'Описание',
      description: 'Полное описание',
      version: '1.0.0',
      minecraft: '1.20.1',
      loader: { type: 'fabric', version: '0.16.0' },
      recommendedMemoryMb: 4096,
      manifestUrl: `${baseUrl}/rel/v1/manifest.json`,
      news: 'launcher/news.json'
    }

    routes.set(`/raw/${repo}/main/launcher/pack.json`, Buffer.from(JSON.stringify(packInfoV1)))
    routes.set('/rel/v1/manifest.json', Buffer.from(JSON.stringify(manifestV1)))
    routes.set('/rel/v1/mod-a.jar', modABuf)
    routes.set('/rel/v1/mod-old.jar', modOldBuf)
    routes.set('/rel/v1/part-1.zip', zipV1)
    // Специально оставляем новости с 404 — это не должно ломать проверку сборки!

    const catalog = new CatalogService(userDataDir)
    const settings = defaultSettings(userDataDir)
    settings.installDir = installDir
    settings.catalogUrl = ''
    settings.customRepos = [{ repo, branch: 'main', path: 'launcher/pack.json' }]

    const loaded = await catalog.loadCatalog(settings, localOpts())
    expect(loaded.packs).toHaveLength(1)
    expect(loaded.packs[0].status).toBe('not-installed')

    const { manifest: fetchedM1 } = await catalog.fetchPackAndManifest(
      catalog.getEntry(packKey)!.sourceRef,
      localOpts()
    )
    const plan1 = await planPackSync(instanceDir, fetchedM1, { fullVerify: true })
    expect(plan1.toDownload).toHaveLength(5)
    expect(plan1.conflicts).toHaveLength(0)

    await applyPackSync(instanceDir, fetchedM1, plan1, {}, localOpts())
    expect((await readPackState(instanceDir))?.version).toBe('1.0.0')
    expect(await readFile(join(instanceDir, 'mods/mod-a.jar'), 'utf8')).toBe('mod-a-content-v1')
    expect(await readFile(join(instanceDir, 'config/required.toml'), 'utf8')).toBe('required-config-v1')

    // Личные файлы игрока
    await mkdir(join(instanceDir, 'saves/world1'), { recursive: true })
    await mkdir(join(instanceDir, 'screenshots'), { recursive: true })
    await mkdir(join(instanceDir, 'resourcepacks'), { recursive: true })
    await writeFile(join(instanceDir, 'saves/world1/level.dat'), 'world-save-data')
    await writeFile(join(instanceDir, 'screenshots/2026.png'), 'png-data')
    await writeFile(join(instanceDir, 'resourcepacks/my-pack.zip'), 'user-rp')
    await writeFile(join(instanceDir, 'options.txt'), 'lang:ru_ru\nfov:90\n')
    await writeFile(join(instanceDir, 'mods/user-extra.jar'), 'user-extra-mod')

    // Повторная проверка без изменений: 0 загрузок, 0 удалений, предупреждение про доп. мод
    requestCounts.clear()
    const planNoop = await planPackSync(instanceDir, fetchedM1, { fullVerify: true })
    expect(planNoop.toDownload).toHaveLength(0)
    expect(planNoop.toDelete).toHaveLength(0)
    expect(planNoop.conflicts).toHaveLength(0)
    expect(planNoop.warnings.some((w) => w.includes('user-extra.jar'))).toBe(true)

    // Пользователь меняет управляемые файлы: обязательный и необязательный
    await writeFile(join(instanceDir, 'config/required.toml'), 'USER_EDITED_REQUIRED')
    await writeFile(join(instanceDir, 'config/optional.toml'), 'USER_EDITED_OPTIONAL')

    // Версия 1.1.0: mod-old.jar удалён, добавлен mod-b.jar, mod-a.jar без изменений
    const modBBuf = Buffer.from('new-mod-b-v2')
    const cfgRequiredV2 = Buffer.from('required-config-v2')
    const cfgOptionalV2 = Buffer.from('optional-config-v2')
    const zipV2 = await makeZipBuffer([
      { name: 'config/required.toml', content: cfgRequiredV2 },
      { name: 'config/optional.toml', content: cfgOptionalV2 },
      { name: 'options.txt', content: optionsInitBuf }
    ])

    const manifestV2: Manifest = {
      schemaVersion: 1,
      packId: 'test-pack',
      version: '1.1.0',
      minecraft: '1.20.1',
      loader: { type: 'fabric', version: '0.16.0' },
      archives: [
        {
          id: 'part-2',
          url: `${baseUrl}/rel/v2/part-2.zip`,
          size: zipV2.length,
          sha256: sha256Text(zipV2)
        }
      ],
      files: [
        manifestV1.files[0], // mod-a.jar не изменился!
        {
          path: 'mods/mod-b.jar',
          size: modBBuf.length,
          sha256: sha256Text(modBBuf),
          mode: 'managed',
          required: true,
          source: { url: `${baseUrl}/rel/v2/mod-b.jar` }
        },
        {
          path: 'config/required.toml',
          size: cfgRequiredV2.length,
          sha256: sha256Text(cfgRequiredV2),
          mode: 'managed',
          required: true,
          source: { archive: 'part-2', entry: 'config/required.toml' }
        },
        {
          path: 'config/optional.toml',
          size: cfgOptionalV2.length,
          sha256: sha256Text(cfgOptionalV2),
          mode: 'managed',
          required: false,
          source: { archive: 'part-2', entry: 'config/optional.toml' }
        },
        {
          ...manifestV1.files[4],
          source: { archive: 'part-2', entry: 'options.txt' }
        } // options.txt initial
      ]
    }
    const packInfoV2: PackInfo = {
      ...packInfoV1,
      version: '1.1.0',
      manifestUrl: `${baseUrl}/rel/v2/manifest.json`
    }
    routes.set(`/raw/${repo}/main/launcher/pack.json`, Buffer.from(JSON.stringify(packInfoV2)))
    routes.set('/rel/v2/manifest.json', Buffer.from(JSON.stringify(manifestV2)))
    routes.set('/rel/v2/mod-b.jar', modBBuf)
    routes.set('/rel/v2/part-2.zip', zipV2)

    const { manifest: fetchedM2 } = await catalog.fetchPackAndManifest(
      catalog.getEntry(packKey)!.sourceRef,
      localOpts()
    )

    requestCounts.clear()
    const planV2 = await planPackSync(instanceDir, fetchedM2, { fullVerify: true })
    expect(planV2.toDownload.map((f) => f.path)).toEqual(['mods/mod-b.jar'])
    expect(planV2.toDelete).toEqual(['mods/mod-old.jar'])
    expect(planV2.conflicts).toEqual([
      { path: 'config/required.toml', kind: 'modified', canKeep: false },
      { path: 'config/optional.toml', kind: 'modified', canKeep: true }
    ])

    // Попытка проигнорировать или оставить обязательный файл должна блокироваться
    await expect(applyPackSync(instanceDir, fetchedM2, planV2, {}, localOpts())).rejects.toThrowError(LauncherError)
    await expect(
      applyPackSync(
        instanceDir,
        fetchedM2,
        planV2,
        { 'config/required.toml': 'keep', 'config/optional.toml': 'keep' },
        localOpts()
      )
    ).rejects.toThrowError(LauncherError)

    // Разрешаем: обязательный заменить (с бэкапом), необязательный оставить
    await applyPackSync(
      instanceDir,
      fetchedM2,
      planV2,
      { 'config/required.toml': 'replace', 'config/optional.toml': 'keep' },
      localOpts()
    )

    // mod-a.jar не перекачивался
    expect(requestCounts.get('/rel/v1/mod-a.jar') ?? 0).toBe(0)
    expect(requestCounts.get('/rel/v2/mod-b.jar')).toBe(1)

    // Устаревший неизменённый mod-old.jar удалён
    const modsDir = await readdir(join(instanceDir, 'mods'))
    expect(modsDir).toContain('mod-a.jar')
    expect(modsDir).toContain('mod-b.jar')
    expect(modsDir).toContain('user-extra.jar')
    expect(modsDir).not.toContain('mod-old.jar')

    // Конфликтные файлы и бэкап
    expect(await readFile(join(instanceDir, 'config/required.toml'), 'utf8')).toBe('required-config-v2')
    expect(await readFile(join(instanceDir, 'config/optional.toml'), 'utf8')).toBe('USER_EDITED_OPTIONAL')
    const backups = await readdir(join(instanceDir, '.abilauncher/backups'))
    expect(backups.length).toBe(1)
    expect(
      await readFile(join(instanceDir, '.abilauncher/backups', backups[0], 'config/required.toml'), 'utf8')
    ).toBe('USER_EDITED_REQUIRED')

    // Личные файлы игрока не пострадали
    expect(await readFile(join(instanceDir, 'saves/world1/level.dat'), 'utf8')).toBe('world-save-data')
    expect(await readFile(join(instanceDir, 'screenshots/2026.png'), 'utf8')).toBe('png-data')
    expect(await readFile(join(instanceDir, 'resourcepacks/my-pack.zip'), 'utf8')).toBe('user-rp')
    expect(await readFile(join(instanceDir, 'options.txt'), 'utf8')).toBe('lang:ru_ru\nfov:90\n')

    // Повторная проверка V2 не спрашивает повторно про оставленный optional.toml
    const planV2Again = await planPackSync(instanceDir, fetchedM2, { fullVerify: true })
    expect(planV2Again.conflicts).toHaveLength(0)
    expect(planV2Again.toDownload).toHaveLength(0)

    // Проверка новостей при 404 не бросает исключение и не блокирует сборку
    const newsRes = await catalog.loadNews(catalog.getAllEntries(), localOpts())
    expect(newsRes.items).toHaveLength(0)

    // Версия 1.2.0: проверка конфликта устаревшего файла, изменённого игроком (obsolete-modified)
    await writeFile(join(instanceDir, 'mods/mod-b.jar'), 'USER_EDITED_OBSOLETE_MOD')
    const manifestV3: Manifest = {
      ...manifestV2,
      version: '1.2.0',
      files: manifestV2.files.filter((f) => f.path !== 'mods/mod-b.jar')
    }
    const planV3 = await planPackSync(instanceDir, manifestV3, { fullVerify: true })
    expect(planV3.conflicts).toEqual([
      { path: 'mods/mod-b.jar', kind: 'obsolete-modified', canKeep: true }
    ])
    await applyPackSync(instanceDir, manifestV3, planV3, { 'mods/mod-b.jar': 'replace' }, localOpts())
    const modsAfterV3 = await readdir(join(instanceDir, 'mods'))
    expect(modsAfterV3).not.toContain('mod-b.jar')
    const backupDirs = (await readdir(join(instanceDir, '.abilauncher/backups'))).sort()
    expect(backupDirs.length).toBeGreaterThanOrEqual(2)

    // Проверка staging: заранее подготовленный файл в staging/files не запрашивается повторно с сервера
    const modCBuf = Buffer.from('staged-mod-c')
    const manifestV4: Manifest = {
      ...manifestV3,
      version: '1.3.0',
      files: [
        ...manifestV3.files,
        {
          path: 'mods/mod-c.jar',
          size: modCBuf.length,
          sha256: sha256Text(modCBuf),
          mode: 'managed',
          required: true,
          source: { url: `${baseUrl}/rel/v4/mod-c.jar` }
        }
      ]
    }
    routes.set('/rel/v4/mod-c.jar', modCBuf)
    const stagedDir = join(instanceDir, '.abilauncher/staging/1.3.0/files/mods')
    await mkdir(stagedDir, { recursive: true })
    await writeFile(join(stagedDir, 'mod-c.jar'), modCBuf)
    requestCounts.clear()
    const planV4 = await planPackSync(instanceDir, manifestV4, { fullVerify: true })
    await applyPackSync(instanceDir, manifestV4, planV4, {}, localOpts())
    expect(requestCounts.get('/rel/v4/mod-c.jar') ?? 0).toBe(0)
    expect(await readFile(join(instanceDir, 'mods/mod-c.jar'), 'utf8')).toBe('staged-mod-c')
  })

  it('докачивает файл с места обрыва по HTTP Range и блокирует запуск при недоступном GitHub или ошибке целостности', async () => {
    const bigBuf = Buffer.alloc(128 * 1024, 0x4b)
    for (let i = 0; i < bigBuf.length; i += 97) bigBuf[i] = i & 0xff
    const bigSha = sha256Text(bigBuf)
    routes.set('/rel/resume/big.bin', bigBuf)

    const dest = join(rootTemp, 'Пробел в пути', 'big.bin')
    failPartialRouteOnce = '/rel/resume/big.bin'

    // С attempts=1 первый вызов падает на обрыве, но оставляет .part ровно на половине файла
    await expect(
      downloadVerified(`${baseUrl}/rel/resume/big.bin`, dest, {
        expectedSize: bigBuf.length,
        expectedSha256: bigSha,
        isAllowed: (u) => u.startsWith(baseUrl),
        attempts: 1
      })
    ).rejects.toThrowError(LauncherError)

    const partBytes = await readFile(dest + '.part')
    expect(partBytes.length).toBe(Math.floor(bigBuf.length / 2))

    // Повторный запуск докачивает вторую половину через Range: bytes=...
    await downloadVerified(`${baseUrl}/rel/resume/big.bin`, dest, {
      expectedSize: bigBuf.length,
      expectedSha256: bigSha,
      isAllowed: (u) => u.startsWith(baseUrl),
      attempts: 1
    })
    expect((await readFile(dest)).equals(bigBuf)).toBe(true)

    // Несовпадение SHA-256 блокирует сохранение повреждённого файла
    const badDest = join(rootTemp, 'bad-integrity.bin')
    await expect(
      downloadVerified(`${baseUrl}/rel/resume/big.bin`, badDest, {
        expectedSize: bigBuf.length,
        expectedSha256: 'f'.repeat(64),
        isAllowed: (u) => u.startsWith(baseUrl),
        attempts: 1
      })
    ).rejects.toMatchObject({ code: 'integrity' })

    // Недоступность сервера (неверный порт) блокирует предпусковую проверку
    const catalog = new CatalogService(join(rootTemp, 'offline-check'))
    await expect(
      catalog.fetchPackAndManifest(
        { repo: 'Test/Offline', branch: 'main', path: 'launcher/pack.json', official: false },
        {
          isAllowed: () => true,
          resolveRawUrl: () => 'http://127.0.0.1:1/launcher/pack.json',
          timeoutMs: 1500
        }
      )
    ).rejects.toThrowError(LauncherError)
  })

  it('отклоняет ZIP с path traversal (Zip Slip) и ничего не записывает за пределы папки', async () => {
    // Создаём обычный zip и подменяем имя файла `xx/evil.txt` -> `../evil.txt`
    // с сохранением длины имени (9 байт), чтобы смещения в Central Directory остались точными!
    const validZip = await makeZipBuffer([{ name: 'xx/ev.txt', content: Buffer.from('evil') }])
    const patchedZip = Buffer.from(validZip)
    const needle = Buffer.from('xx/ev.txt', 'ascii')
    const replacement = Buffer.from('../ev.txt', 'ascii')
    let pos = 0
    while (true) {
      const idx = patchedZip.indexOf(needle, pos)
      if (idx === -1) break
      replacement.copy(patchedZip, idx)
      pos = idx + needle.length
    }

    const zipPath = join(rootTemp, 'zipslip.zip')
    const extractDir = join(rootTemp, 'zipslip-out', 'nested')
    await mkdir(extractDir, { recursive: true })
    await writeFile(zipPath, patchedZip)

    const map = new Map([
      [
        '../ev.txt',
        {
          targetAbsPath: join(extractDir, 'safe.txt'),
          expectedSize: 4,
          expectedSha256: sha256Text('evil')
        }
      ]
    ])

    await expect(extractZipEntries(zipPath, map, extractDir)).rejects.toMatchObject({
      code: 'manifest-invalid'
    })
  })
})
