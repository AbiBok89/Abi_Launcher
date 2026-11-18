import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_EXTRA_JVM_ARGS,
  createMinecraftProcessWatcher,
  launch,
  type LaunchOption,
  type ResolvedVersion
} from '@xmcl/core'
import type { ServerRef } from '@shared/schemas'
import type { GameEvent, Profile, Settings } from '@shared/types'
import { LauncherError } from './errors'
import { ensureDir } from './fsutil'
import { logger } from './log'

const mcLog = logger.scope('minecraft')
const log = logger.scope('launcher')

export function supportsQuickPlay(mcVersion: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(mcVersion.trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 1 || minor >= 20
}

export function supportsLegacyServerArg(mcVersion: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(mcVersion.trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major === 1 && minor >= 6 && minor < 20
}

export function parseJvmArgs(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) args.push(current)
  return args
}

const CUSTOM_GC_RE = /^-XX:\+Use(?:G1|Z|Shenandoah|Serial|Parallel|ConcMarkSweep)GC$/

/**
 * Готовит итоговый список extraJVMArgs: убирает дубли -Xms/-Xmx и сохраняет
 * стандартные G1GC-флаги, если пользователь не задал другой сборщик мусора.
 */
export function buildExtraJvmArgs(raw?: string | null): string[] | undefined {
  if (!raw || !raw.trim()) return undefined
  const filtered = parseJvmArgs(raw).filter(
    (arg) => !/^-Xm[sx]\d+[kmgKMG]?$/i.test(arg)
  )
  if (filtered.length === 0) return undefined
  if (filtered.some((arg) => CUSTOM_GC_RE.test(arg))) {
    return filtered
  }
  return [...DEFAULT_EXTRA_JVM_ARGS.filter((v) => v !== '-Xmx2G'), ...filtered]
}

export interface LaunchGameOptions {
  packKey: string
  installDir: string
  instanceDir: string
  resolvedVersion: ResolvedVersion
  javaPath: string
  profile: Profile
  memoryMb: number
  extraJvmArgs?: string | null
  resolution: Settings['resolution']
  server: ServerRef | null
  joinServer: boolean
  onGameEvent?: (ev: GameEvent) => void
}

function attachLineLogger(stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void {
  if (!stream) return
  let buf = ''
  stream.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString()
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (trimmed) mcLog[level](trimmed)
    }
  })
  stream.on('end', () => {
    const trimmed = buf.trimEnd()
    if (trimmed) mcLog[level](trimmed)
  })
}

export async function launchGame(opts: LaunchGameOptions): Promise<ChildProcess> {
  if (!opts.profile) {
    throw new LauncherError(
      'no-profile',
      'Не выбран локальный профиль',
      'Перед запуском игры выберите или создайте локальный профиль на вкладке «Профили».'
    )
  }

  await ensureDir(opts.instanceDir)
  const sharedDir = join(opts.installDir, 'shared')
  const maxMemory = Math.max(1024, Math.round(opts.memoryMb))
  const minMemory = Math.min(1024, maxMemory)

  const extraJVMArgs = buildExtraJvmArgs(opts.extraJvmArgs)

  const launchOption: LaunchOption = {
    gamePath: opts.instanceDir,
    resourcePath: sharedDir,
    javaPath: opts.javaPath,
    version: opts.resolvedVersion,
    gameProfile: {
      name: opts.profile.name,
      id: opts.profile.uuid.replace(/-/g, '')
    },
    accessToken: '0',
    userType: 'legacy',
    launcherName: 'AbiLauncher',
    launcherBrand: 'AbiLauncher',
    minMemory,
    maxMemory,
    ...(extraJVMArgs ? { extraJVMArgs } : {}),
    resolution: opts.resolution.fullscreen
      ? { fullscreen: true }
      : {
          width: opts.resolution.width,
          height: opts.resolution.height,
          fullscreen: false
        },
    extraExecOption: {
      cwd: opts.instanceDir,
      windowsHide: true
    }
  }

  if (opts.joinServer && opts.server) {
    const port = opts.server.port ?? 25565
    if (supportsQuickPlay(opts.resolvedVersion.minecraftVersion)) {
      launchOption.quickPlayMultiplayer = `${opts.server.host}:${port}`
    } else if (supportsLegacyServerArg(opts.resolvedVersion.minecraftVersion)) {
      launchOption.server = { ip: opts.server.host, port }
    }
  }

  log.info(
    `Запуск сборки ${opts.packKey} (MC ${opts.resolvedVersion.minecraftVersion}, версия ${opts.resolvedVersion.id}, ОЗУ ${maxMemory} МБ)`
  )

  let child: ChildProcess
  try {
    child = await launch(launchOption)
  } catch (e) {
    throw new LauncherError(
      'launch-failed',
      'Не удалось запустить Minecraft',
      e instanceof Error ? e.message : String(e),
      'Проверьте настройки Java, объём выделенной памяти и журнал запуска.',
      { cause: e }
    )
  }

  attachLineLogger(child.stdout, 'info')
  attachLineLogger(child.stderr, 'warn')

  opts.onGameEvent?.({ packKey: opts.packKey, state: 'started' })

  const watcher = createMinecraftProcessWatcher(child)
  watcher.on('error', (err) => {
    log.error(`Ошибка процесса игры (${opts.packKey})`, err)
  })
  watcher.on('minecraft-exit', async ({ code, signal, crashReport, crashReportLocation }) => {
    log.info(`Игра завершилась (код: ${code ?? 'null'}, сигнал: ${signal ?? 'нет'})`)
    let reportText: string | null = crashReport || null
    if (!reportText && crashReportLocation) {
      reportText = await readFile(crashReportLocation, 'utf8').catch(() => null)
    }
    opts.onGameEvent?.({
      packKey: opts.packKey,
      state: 'exited',
      exitCode: code,
      crashReport: reportText ? reportText.slice(0, 8000) : null,
      crashReportPath: crashReportLocation ?? null
    })
  })

  return child
}
