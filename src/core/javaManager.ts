import { chmod, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  DEFAULT_RUNTIME_ALL_URL,
  createJavaRuntimeInstallWorkflow,
  executeInstallWorkflow,
  getPotentialJavaLocations,
  resolveJava,
  resolveJavaWithDiagnostic,
  scanLocalJava,
  type JavaRuntimes,
  type JavaRuntimeTarget
} from '@xmcl/installer'
import { isAllowedUrl } from '@shared/schemas'
import type { JavaInfoView } from '@shared/types'
import { extractArchiveSafe } from './archive'
import { CancelledError, LauncherError, isAbortError, throwIfAborted } from './errors'
import { ensureDir, exists, removeQuiet, renameWithRetry } from './fsutil'
import { downloadVerified, fetchText } from './http'
import { logger } from './log'
import { createTrackedXmclRuntime, type RuntimeProgressUpdate } from './xmclRuntime'

const log = logger.scope('java')

const ADOPTIUM_HOSTS = ['api.adoptium.net', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']

function isAllowedJavaUrl(url: string): boolean {
  if (isAllowedUrl(url)) return true
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && ADOPTIUM_HOSTS.includes(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function requiredJavaMajor(
  minecraftVersion: string,
  manifestJavaMajor?: number,
  resolvedJavaMajor?: number
): number {
  if (manifestJavaMajor && manifestJavaMajor >= 8) return manifestJavaMajor
  if (resolvedJavaMajor && resolvedJavaMajor >= 8) return resolvedJavaMajor

  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(minecraftVersion.trim())
  if (!m) return 21
  const minor = Number(m[1])
  const patch = Number(m[2] ?? '0')
  if (minor <= 16) return 8
  if (minor < 20 || (minor === 20 && patch <= 4)) return 17
  return 21
}

function javaExeName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

export function managedRuntimeDir(installDir: string, major: number): string {
  return join(installDir, 'runtimes', `java-${major}-${process.platform}-${process.arch}`)
}

export function managedJavaExecutable(runtimeDir: string): string {
  return join(runtimeDir, 'bin', javaExeName())
}

async function listManagedExecutables(installDir: string): Promise<string[]> {
  const runtimesRoot = join(installDir, 'runtimes')
  const candidates: string[] = []
  let entries
  try {
    entries = await readdir(runtimesRoot, { withFileTypes: true })
  } catch {
    return candidates
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const exe = managedJavaExecutable(join(runtimesRoot, entry.name))
    if (await exists(exe)) candidates.push(exe)
  }
  return candidates
}

export async function discoverJavaInstallations(installDir: string): Promise<JavaInfoView[]> {
  const managedPaths = await listManagedExecutables(installDir)
  const potential = await getPotentialJavaLocations().catch(() => [])
  const uniquePaths = Array.from(new Set([...managedPaths, ...potential].map((p) => resolve(p))))
  const scanned = await scanLocalJava(uniquePaths).catch(() => [])
  const runtimesRoot = resolve(join(installDir, 'runtimes'))
  const seen = new Set<string>()
  const out: JavaInfoView[] = []

  for (const j of scanned) {
    const abs = resolve(j.path)
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      path: abs,
      version: j.version,
      majorVersion: j.majorVersion,
      managed: abs.startsWith(runtimesRoot)
    })
  }
  return out.sort((a, b) => Number(b.managed) - Number(a.managed) || b.majorVersion - a.majorVersion)
}

export async function validateJavaExecutable(javaPath: string): Promise<JavaInfoView> {
  const abs = resolve(javaPath.trim())
  if (!(await exists(abs))) {
    throw new LauncherError(
      'java',
      'Файл Java не найден',
      `Исполняемый файл «${abs}» не существует.`,
      'Выберите правильный файл java.exe / java или переключитесь на автоматическую Java.'
    )
  }
  const diag = await resolveJavaWithDiagnostic(abs)
  if (!diag.java) {
    const details = diag.stderr?.trim() || diag.stdout?.trim() || `код выхода ${diag.exitCode ?? 'неизвестен'}`
    throw new LauncherError(
      'java',
      'Не удалось проверить Java',
      `Выбранный файл «${abs}» не отвечает как Java (${details}).`,
      'Выберите корректный исполняемый файл Java или включите автоматическую установку.'
    )
  }
  return {
    path: resolve(diag.java.path),
    version: diag.java.version,
    majorVersion: diag.java.majorVersion,
    managed: false
  }
}

function mojangPlatformKey(): keyof JavaRuntimes | null {
  if (process.platform === 'win32') {
    if (process.arch === 'x64') return 'windows-x64'
    if (process.arch === 'ia32') return 'windows-x86'
    if (process.arch === 'arm64') return 'windows-arm64'
    return null
  }
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux'
    if (process.arch === 'ia32') return 'linux-i386'
    return null
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  }
  return null
}

function mojangTargetCandidates(major: number): string[] {
  if (major >= 21) return ['java-runtime-delta']
  if (major === 17) return ['java-runtime-gamma', 'java-runtime-gamma-snapshot', 'java-runtime-beta']
  if (major === 16) return ['java-runtime-alpha']
  if (major === 8) return ['jre-legacy']
  return []
}

function parseMajorFromVersionName(name: string): number | null {
  if (name.startsWith('1.8')) return 8
  const m = /^(\d+)/.exec(name.trim())
  return m ? Number(m[1]) : null
}

async function tryInstallMojangJava(
  major: number,
  destDir: string,
  signal?: AbortSignal,
  onProgress?: (p: RuntimeProgressUpdate) => void
): Promise<boolean> {
  const platKey = mojangPlatformKey()
  const candidates = mojangTargetCandidates(major)
  if (!platKey || candidates.length === 0) return false

  let allJson: JavaRuntimes
  try {
    const raw = await fetchText(DEFAULT_RUNTIME_ALL_URL, {
      signal,
      isAllowed: (u) => u.startsWith('https://launchermeta.mojang.com/') || u.startsWith('https://piston-meta.mojang.com/')
    })
    allJson = JSON.parse(raw) as JavaRuntimes
  } catch (e) {
    if (isAbortError(e)) throw e
    log.warn('Не удалось получить индекс Java от Mojang, пробуем Adoptium', e)
    return false
  }

  const platformTargets = allJson[platKey]
  if (!platformTargets) return false

  let chosenTarget: JavaRuntimeTarget | undefined
  for (const name of candidates) {
    const arr = platformTargets[name]
    if (arr && arr.length > 0 && parseMajorFromVersionName(arr[0].version.name) === major) {
      chosenTarget = arr[0]
      break
    }
  }
  if (!chosenTarget) return false

  onProgress?.({
    stage: 'java',
    label: `Загрузка официальной Java ${major} (${chosenTarget.version.name})`,
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    speed: 0
  })

  await ensureDir(destDir)
  const tracked = createTrackedXmclRuntime({
    stage: 'java',
    label: `Установка Java ${major}`,
    signal,
    onProgress
  })

  try {
    const workflow = createJavaRuntimeInstallWorkflow({
      target: chosenTarget,
      destination: destDir
    })
    await executeInstallWorkflow(workflow, tracked.runtime, {
      signal,
      onEvent: tracked.onEvent
    })
    return true
  } finally {
    tracked.stop()
  }
}

interface AdoptiumRelease {
  binary?: {
    package?: {
      checksum?: string
      link?: string
      name?: string
      size?: number
    }
  }
}

function adoptiumOsArch(): { os: string; arch: string } {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch =
    process.arch === 'arm64'
      ? 'aarch64'
      : process.arch === 'ia32'
        ? 'x86'
        : 'x64'
  return { os, arch }
}

async function installAdoptiumJava(
  major: number,
  destDir: string,
  signal?: AbortSignal,
  onProgress?: (p: RuntimeProgressUpdate) => void
): Promise<void> {
  const { os, arch } = adoptiumOsArch()
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`

  onProgress?.({
    stage: 'java',
    label: `Поиск Eclipse Temurin Java ${major} (${os}/${arch})`,
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    speed: 0
  })

  let releases: AdoptiumRelease[]
  try {
    const text = await fetchText(apiUrl, { signal, isAllowed: isAllowedJavaUrl })
    releases = JSON.parse(text) as AdoptiumRelease[]
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new LauncherError(
      'java',
      `Не удалось скачать Java ${major}`,
      `Не удалось получить ссылку на Java ${major} для ${os}/${arch}.`,
      'Проверьте интернет-соединение или установите Java вручную и укажите путь в настройках.',
      { cause: e }
    )
  }

  const pkg = releases[0]?.binary?.package
  if (!pkg?.link || !pkg.checksum || !pkg.size) {
    throw new LauncherError(
      'java',
      `Java ${major} не найдена`,
      `Для платформы ${os}/${arch} не найден готовый пакет Java ${major}.`,
      'Установите Java вручную и укажите путь к ней в настройках.'
    )
  }

  const isZip = pkg.link.endsWith('.zip') || (pkg.name?.endsWith('.zip') ?? false)
  const format: 'zip' | 'tar.gz' = isZip ? 'zip' : 'tar.gz'
  const archiveTmp = join(destDir, '..', `.download-java-${major}.${isZip ? 'zip' : 'tar.gz'}`)
  let downloaded = 0
  let lastWindow = Date.now()
  let windowBytes = 0
  let speed = 0

  await downloadVerified(pkg.link, archiveTmp, {
    signal,
    expectedSize: pkg.size,
    expectedSha256: pkg.checksum.toLowerCase(),
    isAllowed: isAllowedJavaUrl,
    onBytes: (delta) => {
      downloaded = Math.max(0, downloaded + delta)
      if (delta > 0) windowBytes += delta
      const now = Date.now()
      if (now - lastWindow >= 400) {
        speed = Math.round((windowBytes * 1000) / (now - lastWindow))
        windowBytes = 0
        lastWindow = now
      }
      onProgress?.({
        stage: 'java',
        label: `Загрузка Java ${major} (Adoptium Temurin)`,
        bytesDone: downloaded,
        bytesTotal: pkg.size!,
        filesDone: 0,
        filesTotal: 1,
        speed
      })
    }
  })

  onProgress?.({
    stage: 'java',
    label: `Распаковка Java ${major}`,
    bytesDone: pkg.size,
    bytesTotal: pkg.size,
    filesDone: 0,
    filesTotal: 1,
    speed: 0
  })

  await removeQuiet(destDir)
  await ensureDir(destDir)
  await extractArchiveSafe(archiveTmp, destDir, format, 1, signal)
  await removeQuiet(archiveTmp)

  const exe = managedJavaExecutable(destDir)
  if (process.platform !== 'win32' && (await exists(exe))) {
    await chmod(exe, 0o755).catch(() => undefined)
  }
}

export async function ensureJavaRuntime(
  major: number,
  installDir: string,
  opts: {
    customJavaPath?: string | null
    signal?: AbortSignal
    onProgress?: (p: RuntimeProgressUpdate) => void
  } = {}
): Promise<JavaInfoView> {
  throwIfAborted(opts.signal)

  if (opts.customJavaPath && opts.customJavaPath.trim()) {
    const info = await validateJavaExecutable(opts.customJavaPath)
    if (info.majorVersion !== major) {
      throw new LauncherError(
        'java',
        'Несовместимая версия Java',
        `Выбрана Java ${info.majorVersion} (${info.version}), а для этой сборки требуется Java ${major}.`,
        'Сбросьте выбор Java на «Автоматически» или выберите совместимую Java в настройках.'
      )
    }
    return info
  }

  const targetDir = managedRuntimeDir(installDir, major)
  const exe = managedJavaExecutable(targetDir)
  if (await exists(exe)) {
    const existing = await resolveJava(exe)
    if (existing && existing.majorVersion === major) {
      return { path: resolve(existing.path), version: existing.version, majorVersion: existing.majorVersion, managed: true }
    }
  }

  // Также проверим другие управляемые рантаймы той же мажорной версии
  for (const candidate of await listManagedExecutables(installDir)) {
    const info = await resolveJava(candidate)
    if (info && info.majorVersion === major) {
      return { path: resolve(info.path), version: info.version, majorVersion: info.majorVersion, managed: true }
    }
  }

  log.info(`Автоматическая установка Java ${major} в ${targetDir}`)
  const stagingRuntime = `${targetDir}.installing`
  await removeQuiet(stagingRuntime)

  try {
    const installedByMojang = await tryInstallMojangJava(major, stagingRuntime, opts.signal, opts.onProgress)
    if (!installedByMojang) {
      await removeQuiet(stagingRuntime)
      await installAdoptiumJava(major, stagingRuntime, opts.signal, opts.onProgress)
    }

    // Проверяем, что java внутри staging работает, прежде чем делать доступной
    let checkExe = managedJavaExecutable(stagingRuntime)
    if (!(await exists(checkExe))) {
      // На macOS структура иногда Contents/Home/bin/java
      const macExe = join(stagingRuntime, 'Contents', 'Home', 'bin', javaExeName())
      if (await exists(macExe)) checkExe = macExe
    }

    const st = await stat(checkExe).catch(() => null)
    if (!st) {
      throw new LauncherError('java', 'Java не установлена', `После распаковки не найден файл ${javaExeName()}.`)
    }
    if (process.platform !== 'win32') {
      await chmod(checkExe, 0o755).catch(() => undefined)
    }
    const verified = await resolveJavaWithDiagnostic(checkExe)
    if (!verified.java) {
      throw new LauncherError(
        'java',
        'Установленная Java не запускается',
        `Проверка скачанной Java ${major} завершилась ошибкой: ${verified.stderr || verified.exitCode}.`
      )
    }

    await removeQuiet(targetDir)
    await ensureDir(join(installDir, 'runtimes'))
    await renameWithRetry(stagingRuntime, targetDir)

    const finalExe = join(targetDir, relative(stagingRuntime, checkExe))
    return {
      path: resolve(finalExe),
      version: verified.java.version,
      majorVersion: verified.java.majorVersion,
      managed: true
    }
  } catch (e) {
    await removeQuiet(stagingRuntime)
    if (isAbortError(e)) throw new CancelledError()
    if (e instanceof LauncherError) throw e
    throw new LauncherError(
      'java',
      `Ошибка установки Java ${major}`,
      e instanceof Error ? e.message : String(e),
      'Проверьте интернет-соединение или выберите установленную Java вручную в настройках.',
      { cause: e }
    )
  }
}
