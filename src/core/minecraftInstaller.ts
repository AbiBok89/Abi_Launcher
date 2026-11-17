import { join } from 'node:path'
import { MinecraftFolder, Version, type ResolvedVersion } from '@xmcl/core'
import {
  createFabricInstallWorkflow,
  createModernForgeInstallWorkflow,
  createProfileInstallWorkflow,
  diagnoseInstallation,
  executeInstallManifest,
  executeInstallWorkflow,
  getVersionList,
  resolveAssetInstallFiles,
  resolveAssetMetadataInstallManifest,
  resolveAssetObjectInstallFiles,
  resolveForgeArtifactVersion,
  resolveForgeInstallerFile,
  resolveLibraryInstallFiles,
  resolveMinecraftJarInstallFile,
  resolveMinecraftVersionJsonInstallFile,
  resolveNeoForgedInstallerFile,
  type InstallManifest
} from '@xmcl/installer'
import type { Loader } from '@shared/schemas'
import type { JavaInfoView } from '@shared/types'
import { CancelledError, LauncherError, isAbortError, throwIfAborted } from './errors'
import { ensureDir, readJsonFile, writeJsonAtomic } from './fsutil'
import { requiredJavaMajor } from './javaManager'
import { logger } from './log'
import { createTrackedXmclRuntime, type RuntimeProgressUpdate } from './xmclRuntime'

const log = logger.scope('mc-installer')

interface RuntimeMarker {
  minecraft: string
  loader: Loader
  versionId: string
  updatedAt: string
}

function sameLoader(a: Loader, b: Loader): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'vanilla' || b.type === 'vanilla') return true
  return a.version === b.version
}

function candidateVersionId(minecraft: string, loader: Loader): string {
  switch (loader.type) {
    case 'vanilla':
      return minecraft
    case 'fabric':
      return `${minecraft}-fabric${loader.version}`
    case 'forge':
      return `${minecraft}-forge-${loader.version}`
    case 'neoforge':
      return `neoforge-${loader.version}`
  }
}

async function runManifestStep(
  manifest: InstallManifest,
  stage: RuntimeProgressUpdate['stage'],
  label: string,
  signal?: AbortSignal,
  onProgress?: (p: RuntimeProgressUpdate) => void
): Promise<void> {
  const hasWork = manifest.tasks.some((t) => t.type !== 'files' || t.files.length > 0)
  if (!hasWork) return
  const tracked = createTrackedXmclRuntime({ stage, label, signal, onProgress })
  try {
    await executeInstallManifest(manifest, tracked.runtime, {
      signal,
      attempts: 3,
      onEvent: tracked.onEvent
    })
  } finally {
    tracked.stop()
  }
}

async function installVanillaVersion(
  sharedFolder: MinecraftFolder,
  mcVersion: string,
  signal?: AbortSignal,
  onProgress?: (p: RuntimeProgressUpdate) => void
): Promise<ResolvedVersion> {
  let vanillaResolved: ResolvedVersion | null = null
  try {
    vanillaResolved = await Version.parse(sharedFolder.root, mcVersion)
  } catch {
    vanillaResolved = null
  }

  if (!vanillaResolved) {
    onProgress?.({
      stage: 'minecraft',
      label: `Получение списка версий Minecraft ${mcVersion}`,
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      speed: 0
    })
    const versionList = await getVersionList({ signal })
    const entry = versionList.versions.find((v) => v.id === mcVersion)
    if (!entry) {
      throw new LauncherError(
        'minecraft-install',
        'Версия Minecraft не найдена',
        `Версия Minecraft «${mcVersion}» отсутствует в официальном списке Mojang.`
      )
    }
    const jsonFile = resolveMinecraftVersionJsonInstallFile(entry, sharedFolder, { signal })
    await runManifestStep(
      { schemaVersion: 1, tasks: [{ id: 'mc-version-json', type: 'files', files: [jsonFile] }] },
      'minecraft',
      `Загрузка описания Minecraft ${mcVersion}`,
      signal,
      onProgress
    )
    vanillaResolved = await Version.parse(sharedFolder.root, mcVersion)
  }

  // Клиентский JAR и библиотеки
  const jarFile = resolveMinecraftJarInstallFile(vanillaResolved, { side: 'client', signal })
  const libFiles = resolveLibraryInstallFiles(vanillaResolved.libraries, sharedFolder, { signal })
  const coreFiles = [...(jarFile ? [jarFile] : []), ...libFiles]
  await runManifestStep(
    { schemaVersion: 1, tasks: [{ id: 'mc-core-files', type: 'files', files: coreFiles }] },
    'minecraft',
    `Установка файлов и библиотек Minecraft ${mcVersion}`,
    signal,
    onProgress
  )

  // Индекс ассетов (создаёт и hash-индекс для diagnoseInstallation, и id-индекс для игры)
  const assetMetaPlan = resolveAssetMetadataInstallManifest(vanillaResolved, sharedFolder, {
    useHashForAssetsIndex: true,
    abortSignal: signal
  })
  await runManifestStep(assetMetaPlan, 'minecraft', `Загрузка индекса ресурсов ${mcVersion}`, signal, onProgress)

  const assetObjects = await resolveAssetObjectInstallFiles(vanillaResolved, sharedFolder, {
    useHashForAssetsIndex: true,
    abortSignal: signal
  })
  await runManifestStep(
    { schemaVersion: 1, tasks: [{ id: 'mc-assets', type: 'files', files: assetObjects }] },
    'minecraft',
    `Установка ресурсов Minecraft ${mcVersion}`,
    signal,
    onProgress
  )

  return vanillaResolved
}

async function installModLoader(
  sharedFolder: MinecraftFolder,
  mcVersion: string,
  loader: Loader,
  javaPath: string,
  signal?: AbortSignal,
  onProgress?: (p: RuntimeProgressUpdate) => void
): Promise<string> {
  if (loader.type === 'vanilla') return mcVersion

  if (loader.type === 'fabric') {
    const expectedId = candidateVersionId(mcVersion, loader)
    const tracked = createTrackedXmclRuntime({
      stage: 'loader',
      label: `Установка Fabric ${loader.version}`,
      signal,
      onProgress
    })
    let versionId: string
    try {
      const wf = createFabricInstallWorkflow({
        minecraft: sharedFolder,
        minecraftVersion: mcVersion,
        version: loader.version,
        versionId: expectedId,
        side: 'client',
        signal
      })
      versionId = await executeInstallWorkflow(wf, tracked.runtime, { signal, onEvent: tracked.onEvent })
    } finally {
      tracked.stop()
    }
    const resolved = await Version.parse(sharedFolder.root, versionId)
    const libs = resolveLibraryInstallFiles(resolved.libraries, sharedFolder, { signal })
    await runManifestStep(
      { schemaVersion: 1, tasks: [{ id: 'fabric-libs', type: 'files', files: libs }] },
      'loader',
      `Загрузка библиотек Fabric ${loader.version}`,
      signal,
      onProgress
    )
    return versionId
  }

  if (loader.type === 'forge') {
    const artifactVersion = resolveForgeArtifactVersion(mcVersion, loader.version)
    const { file } = resolveForgeInstallerFile(artifactVersion, undefined, sharedFolder, { signal })
    const tracked = createTrackedXmclRuntime({
      stage: 'loader',
      label: `Установка Forge ${loader.version}`,
      signal,
      onProgress
    })
    let resultVersionId: string
    try {
      const wf = createModernForgeInstallWorkflow({
        id: `forge-${artifactVersion}`,
        minecraft: sharedFolder,
        minecraftVersion: mcVersion,
        installer: file,
        artifactVersion,
        java: javaPath,
        installOptions: { side: 'client' },
        side: 'client'
      })
      const res = await executeInstallWorkflow(wf, tracked.runtime, { signal, onEvent: tracked.onEvent })
      resultVersionId = res.version
    } finally {
      tracked.stop()
    }
    const resolved = await Version.parse(sharedFolder.root, resultVersionId)
    const libs = resolveLibraryInstallFiles(resolved.libraries, sharedFolder, { signal })
    await runManifestStep(
      { schemaVersion: 1, tasks: [{ id: 'forge-libs', type: 'files', files: libs }] },
      'loader',
      `Загрузка библиотек Forge ${loader.version}`,
      signal,
      onProgress
    )
    return resultVersionId
  }

  // NeoForge
  const { file } = await resolveNeoForgedInstallerFile('neoforge', loader.version, sharedFolder, { signal })
  const tracked = createTrackedXmclRuntime({
    stage: 'loader',
    label: `Установка NeoForge ${loader.version}`,
    signal,
    onProgress
  })
  let resultVersionId: string
  try {
    const wf = createModernForgeInstallWorkflow({
      id: `neoforge-${loader.version}`,
      minecraft: sharedFolder,
      minecraftVersion: mcVersion,
      installer: file,
      artifactVersion: loader.version,
      java: javaPath,
      installOptions: { side: 'client' },
      side: 'client'
    })
    const res = await executeInstallWorkflow(wf, tracked.runtime, { signal, onEvent: tracked.onEvent })
    resultVersionId = res.version
  } finally {
    tracked.stop()
  }
  const resolved = await Version.parse(sharedFolder.root, resultVersionId)
  const libs = resolveLibraryInstallFiles(resolved.libraries, sharedFolder, { signal })
  await runManifestStep(
    { schemaVersion: 1, tasks: [{ id: 'neoforge-libs', type: 'files', files: libs }] },
    'loader',
    `Загрузка библиотек NeoForge ${loader.version}`,
    signal,
    onProgress
  )
  return resultVersionId
}

async function repairIfNeeded(
  sharedFolder: MinecraftFolder,
  version: ResolvedVersion,
  javaPath: string,
  signal?: AbortSignal,
  onProgress?: (p: RuntimeProgressUpdate) => void
): Promise<void> {
  const issue = await diagnoseInstallation(version, { strict: false, signal })
  if (!issue) return

  log.warn(`Обнаружены отсутствующие компоненты Minecraft (${Object.keys(issue).join(', ')}), восстанавливаем`)

  if (issue.jar) {
    const jarFile = resolveMinecraftJarInstallFile(version, { side: 'client', signal })
    if (jarFile) {
      await runManifestStep(
        { schemaVersion: 1, tasks: [{ id: 'repair-jar', type: 'files', files: [jarFile] }] },
        'minecraft',
        'Восстановление файла Minecraft',
        signal,
        onProgress
      )
    }
  }

  if (issue.libraries && issue.libraries.length > 0) {
    const files = resolveLibraryInstallFiles(issue.libraries, sharedFolder, { signal })
    await runManifestStep(
      { schemaVersion: 1, tasks: [{ id: 'repair-libs', type: 'files', files }] },
      'minecraft',
      'Восстановление библиотек Minecraft',
      signal,
      onProgress
    )
  }

  if (issue.assetsIndex) {
    const plan = resolveAssetMetadataInstallManifest(version, sharedFolder, {
      useHashForAssetsIndex: true,
      abortSignal: signal
    })
    await runManifestStep(plan, 'minecraft', 'Восстановление индекса ресурсов', signal, onProgress)
    const objects = await resolveAssetObjectInstallFiles(version, sharedFolder, {
      useHashForAssetsIndex: true,
      abortSignal: signal
    })
    await runManifestStep(
      { schemaVersion: 1, tasks: [{ id: 'repair-assets-all', type: 'files', files: objects }] },
      'minecraft',
      'Восстановление ресурсов Minecraft',
      signal,
      onProgress
    )
  } else if (issue.assets && issue.assets.length > 0) {
    const files = resolveAssetInstallFiles(issue.assets, sharedFolder, { abortSignal: signal })
    await runManifestStep(
      { schemaVersion: 1, tasks: [{ id: 'repair-assets', type: 'files', files }] },
      'minecraft',
      'Восстановление ресурсов Minecraft',
      signal,
      onProgress
    )
  }

  if (issue.profile) {
    const tracked = createTrackedXmclRuntime({
      stage: 'loader',
      label: 'Повторная обработка загрузчика модов',
      signal,
      onProgress
    })
    try {
      const wf = createProfileInstallWorkflow({
        id: `repair-profile-${version.id}`,
        profile: issue.profile,
        minecraft: sharedFolder,
        java: javaPath,
        installOptions: { side: 'client' },
        side: 'client'
      })
      await executeInstallWorkflow(wf, tracked.runtime, { signal, onEvent: tracked.onEvent })
    } finally {
      tracked.stop()
    }
  }
}

export async function ensureMinecraftAndLoader(opts: {
  installDir: string
  instanceDir: string
  minecraftVersion: string
  loader: Loader
  manifestJavaMajor?: number
  resolveJava: (major: number) => Promise<JavaInfoView>
  signal?: AbortSignal
  onProgress?: (p: RuntimeProgressUpdate) => void
}): Promise<{ resolvedVersion: ResolvedVersion; javaInfo: JavaInfoView }> {
  throwIfAborted(opts.signal)
  const sharedDir = join(opts.installDir, 'shared')
  await ensureDir(sharedDir)
  const sharedFolder = MinecraftFolder.from(sharedDir)
  const markerPath = join(opts.instanceDir, '.abilauncher', 'runtime.json')

  try {
    // Быстрый путь: проверяем уже установленный runtime и целостность
    const marker = await readJsonFile<RuntimeMarker>(markerPath).catch(() => null)
    const expectedId =
      marker && marker.minecraft === opts.minecraftVersion && sameLoader(marker.loader, opts.loader)
        ? marker.versionId
        : candidateVersionId(opts.minecraftVersion, opts.loader)

    let existingResolved: ResolvedVersion | null = null
    try {
      existingResolved = await Version.parse(sharedDir, expectedId)
    } catch {
      existingResolved = null
    }

    if (existingResolved) {
      const javaMajor = requiredJavaMajor(
        opts.minecraftVersion,
        opts.manifestJavaMajor,
        existingResolved.javaVersion?.majorVersion
      )
      const javaInfo = await opts.resolveJava(javaMajor)
      const issue = await diagnoseInstallation(existingResolved, { strict: false, signal: opts.signal })
      if (!issue) {
        await writeJsonAtomic(markerPath, {
          minecraft: opts.minecraftVersion,
          loader: opts.loader,
          versionId: existingResolved.id,
          updatedAt: new Date().toISOString()
        } satisfies RuntimeMarker)
        return { resolvedVersion: existingResolved, javaInfo }
      }
      log.info(`Среда ${existingResolved.id} требует восстановления`)
    }

    // Полная установка Vanilla -> Java -> Loader -> финальная диагностика
    const vanillaResolved = await installVanillaVersion(
      sharedFolder,
      opts.minecraftVersion,
      opts.signal,
      opts.onProgress
    )
    const javaMajor = requiredJavaMajor(
      opts.minecraftVersion,
      opts.manifestJavaMajor,
      vanillaResolved.javaVersion?.majorVersion
    )
    const javaInfo = await opts.resolveJava(javaMajor)

    const finalVersionId = await installModLoader(
      sharedFolder,
      opts.minecraftVersion,
      opts.loader,
      javaInfo.path,
      opts.signal,
      opts.onProgress
    )

    const finalResolved = await Version.parse(sharedDir, finalVersionId)
    await repairIfNeeded(sharedFolder, finalResolved, javaInfo.path, opts.signal, opts.onProgress)

    await writeJsonAtomic(markerPath, {
      minecraft: opts.minecraftVersion,
      loader: opts.loader,
      versionId: finalResolved.id,
      updatedAt: new Date().toISOString()
    } satisfies RuntimeMarker)

    return { resolvedVersion: finalResolved, javaInfo }
  } catch (e) {
    if (isAbortError(e) || opts.signal?.aborted) throw new CancelledError()
    if (e instanceof LauncherError) throw e
    const message = e instanceof AggregateError
      ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))).slice(0, 3).join('; ')
      : e instanceof Error
        ? e.message
        : String(e)
    throw new LauncherError(
      'minecraft-install',
      'Ошибка установки Minecraft / загрузчика',
      message,
      'Проверьте интернет-соединение, свободное место и совместимость выбранной версии Java.',
      { cause: e }
    )
  }
}
