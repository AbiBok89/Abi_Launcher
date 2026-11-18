import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkRelativePath } from '@shared/paths'
import {
  CatalogSchema,
  LegacyLauncherIndexSchema,
  ManifestSchema,
  NewsSchema,
  PackInfoSchema,
  isAllowedUrl,
  legacyIndexToNews,
  legacyIndexToPackInfos
} from '@shared/schemas'

describe('Проверка относительных путей и разрешённых URL', () => {
  it('отклоняет небезопасные пути и обход каталогов', () => {
    const badPaths = [
      '',
      '../evil.txt',
      'mods/../../evil.jar',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'mods\\bad.jar',
      'config/con.cfg',
      'nul',
      'mods/test.',
      'mods/test ',
      '.abilauncher/state.json',
      'mods//a.jar'
    ]
    for (const p of badPaths) {
      expect(checkRelativePath(p), `Путь ${p} должен быть отклонён`).not.toBeNull()
    }
  })

  it('разрешает безопасные пути, включая пробелы и кириллицу', () => {
    const goodPaths = [
      'mods/example-mod.jar',
      'config/Настройки мода/главный конфиг.toml',
      'resourcepacks/Текстуры HD (v2).zip',
      'options.txt'
    ]
    for (const p of goodPaths) {
      expect(checkRelativePath(p), `Путь ${p} должен быть разрешён`).toBeNull()
    }
  })

  it('разрешает только https ссылки на GitHub и Modrinth CDN', () => {
    expect(isAllowedUrl('https://github.com/AbiBok89/abi_tfg/releases/download/v1/manifest.json')).toBe(true)
    expect(isAllowedUrl('https://raw.githubusercontent.com/AbiBok89/Abi_Launcher/main/catalog/catalog.json')).toBe(true)
    expect(isAllowedUrl('https://objects.githubusercontent.com/some/asset')).toBe(true)
    expect(isAllowedUrl('https://cdn.modrinth.com/data/abc/mod.jar')).toBe(true)

    expect(isAllowedUrl('http://github.com/a/b')).toBe(false)
    expect(isAllowedUrl('https://user:pass@github.com/a/b')).toBe(false)
    expect(isAllowedUrl('https://evil.example.com/file.jar')).toBe(false)
    expect(isAllowedUrl('file:///C:/test.jar')).toBe(false)
  })
})

describe('Схемы каталога, сборки, манифеста и новостей', () => {
  const shaA = 'a'.repeat(64)
  const shaB = 'b'.repeat(64)

  it('валидирует демонстрационные файлы из examples и catalog/catalog.json', () => {
    const rootCatalog = JSON.parse(readFileSync('catalog/catalog.json', 'utf8'))
    expect(CatalogSchema.parse(rootCatalog).packs.length).toBeGreaterThan(0)

    const exCatalog = JSON.parse(readFileSync('examples/catalog-repo/catalog/catalog.json', 'utf8'))
    expect(CatalogSchema.parse(exCatalog).packs.length).toBe(2)

    const exPack = JSON.parse(readFileSync('examples/pack-repo/ForLauncher/pack.json', 'utf8'))
    expect(PackInfoSchema.parse(exPack).id).toBe('example-fabric-pack')

    const exNews = JSON.parse(readFileSync('examples/pack-repo/ForLauncher/news.json', 'utf8'))
    expect(NewsSchema.parse(exNews).items.length).toBe(1)

    const exManifest = JSON.parse(readFileSync('examples/pack-repo/release/manifest.example.json', 'utf8'))
    expect(ManifestSchema.parse(exManifest).files.length).toBe(3)
  })

  it('отклоняет дубликаты путей (без учёта регистра), конфликт файл/папка и неизвестный архив', () => {
    expect(() =>
      ManifestSchema.parse({
        schemaVersion: 1,
        packId: 'test',
        version: '1.0.0',
        minecraft: '1.20.1',
        loader: { type: 'vanilla' },
        files: [
          { path: 'mods/Mod.jar', size: 10, sha256: shaA, source: { url: 'https://github.com/a/b/releases/download/1/m.jar' } },
          { path: 'mods/mod.jar', size: 10, sha256: shaB, source: { url: 'https://github.com/a/b/releases/download/1/m2.jar' } }
        ]
      })
    ).toThrow()

    expect(() =>
      ManifestSchema.parse({
        schemaVersion: 1,
        packId: 'test',
        version: '1.0.0',
        minecraft: '1.20.1',
        loader: { type: 'vanilla' },
        files: [
          { path: 'config/file', size: 10, sha256: shaA, source: { url: 'https://github.com/a/b/releases/download/1/a' } },
          { path: 'config/file/nested.txt', size: 10, sha256: shaB, source: { url: 'https://github.com/a/b/releases/download/1/b' } }
        ]
      })
    ).toThrow()

    expect(() =>
      ManifestSchema.parse({
        schemaVersion: 1,
        packId: 'test',
        version: '1.0.0',
        minecraft: '1.20.1',
        loader: { type: 'vanilla' },
        archives: [],
        files: [
          { path: 'config/a.txt', size: 10, sha256: shaA, source: { archive: 'missing-part', entry: 'config/a.txt' } }
        ]
      })
    ).toThrow()
  })

  it('поддерживает плоское поле url в ManifestFileSchema и формат launcher-index.json', () => {
    const m = ManifestSchema.parse({
      schemaVersion: 1,
      packId: 'flat-test',
      version: '1.0.0',
      minecraft: '1.21.1',
      loader: { type: 'neoforge', version: '21.1.77' },
      files: [
        {
          path: 'mods/a.jar',
          size: 5,
          sha256: shaA,
          url: 'https://github.com/a/b/releases/download/1/a.jar'
        }
      ]
    })
    expect(m.files[0].source).toEqual({ url: 'https://github.com/a/b/releases/download/1/a.jar' })

    const legacySample = {
      news: [
        { id: 'n1', date: '14.11.2026', title: 'Обновление V0.13.18', content: 'Тест' }
      ],
      modpacks: [
        {
          id: 'tfg-modern',
          name: 'TerraFirmaGreg-Modern',
          version: 'V0.13.18',
          minecraftVersion: '1.20.1',
          loader: { type: 'forge', version: '47.4.13' },
          serverAddress: 'abibok.20tps.ru:25565',
          backgroundUrl: 'https://raw.githubusercontent.com/AbiBok89/abi_tfg/main/ForLauncher/bg-tfg.jpg',
          description: 'Описание',
          manifestUrl: 'https://github.com/AbiBok89/abi_tfg/releases/download/V0.13.18/manifest.json'
        }
      ]
    }
    const parsedLegacy = LegacyLauncherIndexSchema.parse(legacySample)
    const legacyPacks = legacyIndexToPackInfos(parsedLegacy)
    const legacyNews = legacyIndexToNews(parsedLegacy)
    expect(legacyPacks[0].id).toBe('tfg-modern')
    expect(legacyPacks[0].loader).toEqual({ type: 'forge', version: '47.4.13' })
    expect(legacyPacks[0].server).toEqual({
      name: 'TerraFirmaGreg-Modern',
      host: 'abibok.20tps.ru',
      port: 25565
    })
    expect(legacyNews.items[0].date).toBe('2026-11-14')

    const tfgForLauncherPack = 'D:\\CooodinG\\Working\\abi_tfg\\ForLauncher\\pack.json'
    if (existsSync(tfgForLauncherPack)) {
      const parsedPack = PackInfoSchema.parse(JSON.parse(readFileSync(tfgForLauncherPack, 'utf8')))
      expect(parsedPack.id).toBe('tfg-modern')
      expect(parsedPack.news).toBe('ForLauncher/news.json')
    }
  })
})
