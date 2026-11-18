import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { isAllowedUrl } from '@shared/schemas'
import type { LauncherReleaseAssetInfo, LauncherUpdateState } from '@shared/types'
import { LauncherError, isAbortError } from './errors'
import { sha256File } from './hash'
import { downloadVerified, safeFetch, type RequestOptions } from './http'
import { logger } from './log'

const log = logger.scope('updater')

export const LAUNCHER_GITHUB_REPO = 'AbiBok89/Abi_Launcher'
export const LAUNCHER_RELEASE_API_URL = `https://api.github.com/repos/${LAUNCHER_GITHUB_REPO}/releases/latest`
export const LAUNCHER_RELEASES_PAGE_URL = `https://github.com/${LAUNCHER_GITHUB_REPO}/releases`

const GitHubAssetSchema = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  browser_download_url: z.string().url(),
  digest: z.string().nullable().optional()
})

const GitHubLatestReleaseSchema = z.object({
  tag_name: z.string().min(1).max(64),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().url().optional(),
  published_at: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(GitHubAssetSchema).default([])
})

interface ParsedSemver {
  nums: number[]
  pre: string[]
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, '')
  const [corePart, prePart] = cleaned.split('-', 2)
  if (!corePart || !/^\d+(?:\.\d+)*$/.test(corePart)) return null
  const nums = corePart.split('.').map((n) => Number(n))
  const pre = prePart ? prePart.split('.').filter(Boolean) : []
  return { nums, pre }
}

/** Сравнивает версии формата `0.1.0` / `v0.2.0-beta.1`. Возвращает 1, если a > b; -1, если a < b; 0 если равны. */
export function compareSemver(aRaw: string, bRaw: string): number {
  const a = parseSemver(aRaw)
  const b = parseSemver(bRaw)
  if (!a || !b) {
    return aRaw.trim().replace(/^v/i, '').localeCompare(bRaw.trim().replace(/^v/i, ''))
  }
  const len = Math.max(a.nums.length, b.nums.length)
  for (let i = 0; i < len; i++) {
    const da = a.nums[i] ?? 0
    const db = b.nums[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const pLen = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < pLen; i++) {
    const pa = a.pre[i]
    const pb = b.pre[i]
    if (pa === undefined) return -1
    if (pb === undefined) return 1
    const na = /^\d+$/.test(pa) ? Number(pa) : null
    const nb = /^\d+$/.test(pb) ? Number(pb) : null
    if (na !== null && nb !== null) {
      if (na > nb) return 1
      if (na < nb) return -1
    } else if (na !== null) {
      return -1
    } else if (nb !== null) {
      return 1
    } else {
      const cmp = pa.localeCompare(pb)
      if (cmp !== 0) return cmp > 0 ? 1 : -1
    }
  }
  return 0
}

export function parseSha256Digest(digest?: string | null): string | null {
  if (!digest) return null
  const m = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim())
  return m ? m[1].toLowerCase() : null
}

export function isAllowedLauncherMetadataUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    const host = u.hostname.toLowerCase()
    if (host === 'api.github.com' && u.pathname.toLowerCase() === `/repos/${LAUNCHER_GITHUB_REPO.toLowerCase()}/releases/latest`) {
      return true
    }
    return isAllowedUrl(url)
  } catch {
    return false
  }
}

export function selectLauncherAsset(
  assets: Array<z.infer<typeof GitHubAssetSchema>>,
  platform: NodeJS.Platform,
  arch: string,
  installMode: LauncherUpdateState['installMode'],
  urlValidator: (url: string) => boolean = isAllowedUrl
): LauncherReleaseAssetInfo | null {
  const valid = assets.filter((a) => a.size > 0 && urlValidator(a.browser_download_url))
  const byOrder = (preds: Array<(name: string) => boolean>) => {
    for (const pred of preds) {
      const hit = valid.find((a) => pred(a.name.toLowerCase()))
      if (hit) {
        return {
          name: hit.name,
          url: hit.browser_download_url,
          size: hit.size,
          sha256: parseSha256Digest(hit.digest)
        }
      }
    }
    return null
  }

  if (platform === 'win32') {
    const isExe = (n: string) => n.endsWith('.exe')
    const hasArch = (n: string) => (arch === 'arm64' ? n.includes('arm64') : !n.includes('arm64'))
    if (installMode === 'portable') {
      return byOrder([
        (n) => isExe(n) && n.includes('portable') && hasArch(n),
        (n) => isExe(n) && n.includes('portable'),
        (n) => isExe(n) && hasArch(n),
        (n) => isExe(n)
      ])
    }
    return byOrder([
      (n) => isExe(n) && !n.includes('portable') && hasArch(n),
      (n) => isExe(n) && n.includes('portable') && hasArch(n),
      (n) => isExe(n)
    ])
  }

  if (platform === 'linux') {
    return byOrder([
      (n) => n.endsWith('.appimage'),
      (n) => n.endsWith('.deb'),
      (n) => n.endsWith('.tar.gz')
    ])
  }

  return byOrder([() => true])
}

function sanitizeAssetFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  if (!base || base === '.' || base === '..' || !/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new LauncherError('manifest-invalid', 'Некорректное имя файла обновления', `Имя ассета «${name}» отклонено проверкой безопасности.`)
  }
  return base
}

async function fileExistsWithSizeAndHash(
  filePath: string,
  expectedSize: number,
  expectedSha256: string | null
): Promise<boolean> {
  try {
    const st = await stat(filePath)
    if (!st.isFile() || st.size !== expectedSize) return false
    if (expectedSha256) {
      const actual = await sha256File(filePath)
      return actual === expectedSha256
    }
    return true
  } catch {
    return false
  }
}

async function downloadWithoutHash(
  url: string,
  dest: string,
  expectedSize: number,
  opts: RequestOptions & { onBytes?: (delta: number) => void }
): Promise<void> {
  const part = dest + '.part'
  await mkdir(dirname(dest), { recursive: true })
  const res = await safeFetch(url, { ...opts, timeoutMs: 30 * 60_000 })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new LauncherError('download-failed', 'Не удалось скачать обновление', `Сервер вернул HTTP ${res.status}.`)
  }
  if (!res.body) {
    throw new LauncherError('download-failed', 'Пустой ответ', 'Сервер не передал файл обновления.')
  }
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length
      if (written > expectedSize) {
        cb(new LauncherError('integrity', 'Повреждённый файл', 'Размер обновления превышает заявленный релизом.'))
        return
      }
      opts.onBytes?.(chunk.length)
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(part, { flags: 'w' }), {
    signal: opts.signal
  })
  const st = await stat(part)
  if (st.size !== expectedSize) {
    await unlink(part).catch(() => undefined)
    throw new LauncherError('integrity', 'Неполная загрузка', `Получено ${st.size} из ${expectedSize} байт.`)
  }
  await rename(part, dest)
}

export interface LauncherUpdaterOptions {
  currentVersion: string
  userDataDir: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  arch?: string
  portableExecutablePath?: string | null
  metadataUrl?: string
  requestOpts?: RequestOptions
  onQuit?: () => void
}

export class LauncherUpdater {
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly portableExecutablePath: string | null
  private readonly metadataUrl: string
  private readonly listeners = new Set<(st: LauncherUpdateState) => void>()
  private activeAbort: AbortController | null = null
  private state: LauncherUpdateState

  constructor(private readonly opts: LauncherUpdaterOptions) {
    this.platform = opts.platform ?? process.platform
    this.arch = opts.arch ?? process.arch
    this.portableExecutablePath = opts.portableExecutablePath ?? process.env.PORTABLE_EXECUTABLE_FILE ?? null
    this.metadataUrl = opts.metadataUrl ?? LAUNCHER_RELEASE_API_URL

    const installMode: LauncherUpdateState['installMode'] =
      this.platform === 'win32' && this.portableExecutablePath
        ? 'portable'
        : this.platform === 'win32' && opts.isPackaged
          ? 'installer'
          : 'manual'

    this.state = {
      phase: 'idle',
      currentVersion: opts.currentVersion,
      latestVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseUrl: null,
      publishedAt: null,
      asset: null,
      downloadedPath: null,
      progressBytesDone: 0,
      progressBytesTotal: 0,
      progressSpeed: 0,
      error: null,
      canAutoInstall: installMode !== 'manual',
      installMode,
      checkedAt: null
    }
  }

  getState(): LauncherUpdateState {
    return structuredClone(this.state)
  }

  onState(cb: (state: LauncherUpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private setState(patch: Partial<LauncherUpdateState>): LauncherUpdateState {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    for (const cb of this.listeners) {
      try {
        cb(snapshot)
      } catch {
        /* ignore */
      }
    }
    return snapshot
  }

  async checkForUpdates(): Promise<LauncherUpdateState> {
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      return this.getState()
    }
    this.setState({ phase: 'checking', error: null })
    try {
      const isAllowedMeta = this.opts.requestOpts?.isAllowed ?? isAllowedLauncherMetadataUrl
      const res = await safeFetch(this.metadataUrl, {
        ...this.opts.requestOpts,
        isAllowed: isAllowedMeta,
        timeoutMs: 15_000,
        headers: {
          Accept: 'application/vnd.github+json',
          ...this.opts.requestOpts?.headers
        }
      })

      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined)
        log.info('Официальных релизов лаунчера на GitHub пока нет.')
        return this.setState({
          phase: 'up-to-date',
          latestVersion: null,
          releaseName: null,
          releaseNotes: null,
          releaseUrl: LAUNCHER_RELEASES_PAGE_URL,
          publishedAt: null,
          asset: null,
          downloadedPath: null,
          error: null,
          checkedAt: new Date().toISOString()
        })
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new LauncherError('github-unavailable', 'Ошибка проверки обновлений', `GitHub ответил HTTP ${res.status}.`)
      }

      const rawText = await res.text()
      const parsed = GitHubLatestReleaseSchema.parse(JSON.parse(rawText))
      const latestVersion = parsed.tag_name.trim().replace(/^v/i, '')
      const urlCheck = this.opts.requestOpts?.isAllowed ?? isAllowedUrl
      const asset = selectLauncherAsset(
        parsed.assets,
        this.platform,
        this.arch,
        this.state.installMode,
        urlCheck
      )
      const releaseUrl = parsed.html_url ?? LAUNCHER_RELEASES_PAGE_URL
      const checkedAt = new Date().toISOString()

      if (compareSemver(latestVersion, this.opts.currentVersion) <= 0) {
        return this.setState({
          phase: 'up-to-date',
          latestVersion,
          releaseName: parsed.name ?? parsed.tag_name,
          releaseNotes: parsed.body ?? null,
          releaseUrl,
          publishedAt: parsed.published_at ?? null,
          asset,
          downloadedPath: null,
          error: null,
          checkedAt
        })
      }

      let downloadedPath: string | null = null
      if (asset) {
        const candidate = this.getTargetDownloadPath(latestVersion, asset.name)
        if (await fileExistsWithSizeAndHash(candidate, asset.size, asset.sha256)) {
          downloadedPath = candidate
        }
      }

      log.info(`Найдено обновление AbiLauncher: ${this.opts.currentVersion} -> ${latestVersion}`)
      return this.setState({
        phase: downloadedPath ? 'downloaded' : 'available',
        latestVersion,
        releaseName: parsed.name ?? parsed.tag_name,
        releaseNotes: parsed.body ?? null,
        releaseUrl,
        publishedAt: parsed.published_at ?? null,
        asset,
        downloadedPath,
        progressBytesDone: downloadedPath && asset ? asset.size : 0,
        progressBytesTotal: asset ? asset.size : 0,
        progressSpeed: 0,
        error: null,
        checkedAt
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('Не удалось проверить обновление лаунчера', e)
      return this.setState({
        phase: 'error',
        error: msg,
        checkedAt: new Date().toISOString()
      })
    }
  }

  private getTargetDownloadPath(version: string, assetName: string): string {
    const safeVer = version.replace(/[^A-Za-z0-9._-]/g, '_') || 'latest'
    const safeFile = sanitizeAssetFileName(assetName)
    return join(this.opts.userDataDir, 'updates', safeVer, safeFile)
  }

  async downloadUpdate(): Promise<LauncherUpdateState> {
    if (this.state.phase === 'downloading') return this.getState()
    const asset = this.state.asset
    const latestVersion = this.state.latestVersion
    if (!asset || !latestVersion) {
      throw new LauncherError(
        'download-failed',
        'Файл обновления не найден',
        'В последнем релизе GitHub отсутствует установочный файл для вашей ОС.'
      )
    }

    const dest = this.getTargetDownloadPath(latestVersion, asset.name)
    if (await fileExistsWithSizeAndHash(dest, asset.size, asset.sha256)) {
      return this.setState({
        phase: 'downloaded',
        downloadedPath: dest,
        progressBytesDone: asset.size,
        progressBytesTotal: asset.size,
        progressSpeed: 0,
        error: null
      })
    }

    const ctrl = new AbortController()
    this.activeAbort = ctrl
    this.setState({
      phase: 'downloading',
      downloadedPath: null,
      progressBytesDone: 0,
      progressBytesTotal: asset.size,
      progressSpeed: 0,
      error: null
    })

    let done = 0
    let lastEmit = 0
    let windowStart = Date.now()
    let windowBytes = 0
    let speed = 0

    const onBytes = (delta: number) => {
      done = Math.max(0, done + delta)
      if (delta > 0) windowBytes += delta
      const now = Date.now()
      const elapsed = now - windowStart
      if (elapsed >= 400) {
        speed = Math.round((windowBytes * 1000) / elapsed)
        windowStart = now
        windowBytes = 0
      }
      if (now - lastEmit >= 120 || done >= asset.size) {
        lastEmit = now
        this.setState({
          progressBytesDone: done,
          progressBytesTotal: asset.size,
          progressSpeed: speed
        })
      }
    }

    try {
      const reqOpts: RequestOptions = {
        ...this.opts.requestOpts,
        signal: ctrl.signal
      }
      if (asset.sha256) {
        await downloadVerified(asset.url, dest, {
          ...reqOpts,
          expectedSize: asset.size,
          expectedSha256: asset.sha256,
          onBytes
        })
      } else {
        await downloadWithoutHash(asset.url, dest, asset.size, {
          ...reqOpts,
          onBytes
        })
      }
      log.info(`Обновление лаунчера скачано: ${dest}`)
      return this.setState({
        phase: 'downloaded',
        downloadedPath: dest,
        progressBytesDone: asset.size,
        progressBytesTotal: asset.size,
        progressSpeed: 0,
        error: null
      })
    } catch (e) {
      if (isAbortError(e)) {
        return this.setState({
          phase: 'available',
          progressBytesDone: 0,
          progressSpeed: 0,
          error: null
        })
      }
      const msg = e instanceof Error ? e.message : String(e)
      return this.setState({
        phase: 'error',
        error: msg,
        progressSpeed: 0
      })
    } finally {
      this.activeAbort = null
    }
  }

  cancelDownload(): void {
    this.activeAbort?.abort()
  }

  async installDownloadedUpdate(): Promise<void> {
    const file = this.state.downloadedPath
    const asset = this.state.asset
    if (!file || !asset) {
      throw new LauncherError('download-failed', 'Обновление не скачано', 'Сначала скачайте обновление.')
    }
    const valid = await fileExistsWithSizeAndHash(file, asset.size, asset.sha256)
    if (!valid) {
      this.setState({ phase: 'available', downloadedPath: null })
      throw new LauncherError(
        'integrity',
        'Файл обновления повреждён',
        'Проверка размера или SHA-256 не прошла. Нажмите «Скачать обновление» ещё раз.'
      )
    }

    if (this.platform !== 'win32') {
      throw new LauncherError(
        'unknown',
        'Автоматическая установка недоступна',
        'На вашей ОС откройте страницу релиза и запустите скачанный файл вручную.'
      )
    }

    if (this.state.installMode === 'portable' && this.portableExecutablePath) {
      const updatesRoot = join(this.opts.userDataDir, 'updates')
      await mkdir(updatesRoot, { recursive: true })
      const scriptPath = join(updatesRoot, 'apply-portable-update.ps1')
      const script = [
        'param(',
        '  [Parameter(Mandatory=$true)][int]$WaitPid,',
        '  [Parameter(Mandatory=$true)][string]$SourceFile,',
        '  [Parameter(Mandatory=$true)][string]$TargetFile',
        ')',
        '$deadline = (Get-Date).AddSeconds(25)',
        'while ((Get-Date) -lt $deadline) {',
        '  if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }',
        '  Start-Sleep -Milliseconds 300',
        '}',
        'Start-Sleep -Milliseconds 500',
        '$backup = "$TargetFile.bak"',
        'for ($i = 0; $i -lt 20; $i++) {',
        '  try {',
        '    if (Test-Path -LiteralPath $TargetFile) {',
        '      Move-Item -LiteralPath $TargetFile -Destination $backup -Force',
        '    }',
        '    Move-Item -LiteralPath $SourceFile -Destination $TargetFile -Force',
        '    if (Test-Path -LiteralPath $backup) {',
        '      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue',
        '    }',
        '    Start-Process -FilePath $TargetFile',
        '    exit 0',
        '  } catch {',
        '    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $TargetFile)) {',
        '      Move-Item -LiteralPath $backup -Destination $TargetFile -Force -ErrorAction SilentlyContinue',
        '    }',
        '    Start-Sleep -Milliseconds 500',
        '  }',
        '}'
      ].join('\r\n')
      await writeFile(scriptPath, script, 'utf8')
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          scriptPath,
          '-WaitPid',
          String(process.pid),
          '-SourceFile',
          file,
          '-TargetFile',
          this.portableExecutablePath
        ],
        { detached: true, windowsHide: true, stdio: 'ignore' }
      )
      child.unref()
      log.info(`Запущено обновление portable-лаунчера -> ${this.portableExecutablePath}`)
      this.opts.onQuit?.()
      return
    }

    if (this.state.installMode === 'installer') {
      const child = spawn(file, [], { detached: true, stdio: 'ignore' })
      child.unref()
      log.info(`Запущен установщик обновления: ${file}`)
      this.opts.onQuit?.()
      return
    }

    throw new LauncherError(
      'unknown',
      'Режим разработки',
      'В режиме разработки автоустановка отключена — скачайте или соберите релиз вручную.'
    )
  }
}
