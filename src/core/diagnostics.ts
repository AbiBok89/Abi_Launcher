import { arch, platform, release, totalmem } from 'node:os'
import type { JavaInfoView, PackView, Settings } from '@shared/types'
import { logger } from './log'

export interface DiagnosticsInput {
  launcherVersion: string
  electronVersion: string
  nodeVersion: string
  settings: Settings
  profilesCount: number
  packs: PackView[]
  javaList: JavaInfoView[]
}

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const safeSettings = {
    theme: input.settings.theme,
    installDir: logger.redact(input.settings.installDir),
    catalogUrl: input.settings.catalogUrl,
    customRepos: input.settings.customRepos,
    defaultMemoryMb: input.settings.defaultMemoryMb,
    javaPath: input.settings.javaPath ? logger.redact(input.settings.javaPath) : null,
    resolution: input.settings.resolution,
    afterLaunch: input.settings.afterLaunch,
    fullVerifyOnLaunch: input.settings.fullVerifyOnLaunch,
    autoJoinServer: input.settings.autoJoinServer,
    packOverrides: Object.fromEntries(
      Object.entries(input.settings.packOverrides).map(([k, v]) => [
        k,
        {
          memoryMb: v.memoryMb ?? null,
          javaPath: v.javaPath ? logger.redact(v.javaPath) : null
        }
      ])
    )
  }

  const report = {
    generatedAt: new Date().toISOString(),
    product: 'AbiLauncher',
    note: 'Отчёт не содержит секретов, токенов и персональных данных (имя пользователя и домашний каталог скрыты).',
    environment: {
      launcherVersion: input.launcherVersion,
      electronVersion: input.electronVersion,
      nodeVersion: input.nodeVersion,
      os: `${platform()} ${release()}`,
      arch: arch(),
      totalMemoryMb: Math.floor(totalmem() / (1024 * 1024))
    },
    profilesCount: input.profilesCount,
    settings: safeSettings,
    javaInstallations: input.javaList.map((j) => ({
      path: logger.redact(j.path),
      version: j.version,
      majorVersion: j.majorVersion,
      managed: j.managed
    })),
    packs: input.packs.map((p) => ({
      key: p.key,
      id: p.id,
      name: p.name,
      source: p.source,
      remoteVersion: p.version,
      installedVersion: p.installedVersion,
      minecraft: p.minecraft,
      loader: p.loader,
      status: p.status,
      conflictsCount: p.conflicts.length,
      warnings: p.warnings,
      lastError: p.lastError
        ? {
            code: p.lastError.code,
            title: p.lastError.title,
            message: logger.redact(p.lastError.message)
          }
        : null
    })),
    logs: logger.entries().slice(-500)
  }

  return JSON.stringify(report, null, 2)
}
