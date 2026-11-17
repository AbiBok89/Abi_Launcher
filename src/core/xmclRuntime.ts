import {
  ProgressTrackerMultiple,
  createDefaultNodeInstallRuntime,
  type InstallEvent,
  type InstallRuntime
} from '@xmcl/installer'
import type { Stage } from '@shared/types'

export interface RuntimeProgressUpdate {
  stage: Stage
  label: string
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  speed: number
}

export function createTrackedXmclRuntime(opts: {
  stage: Stage
  label: string
  signal?: AbortSignal
  maxConcurrency?: number
  onProgress?: (p: RuntimeProgressUpdate) => void
}): {
  runtime: InstallRuntime
  onEvent: (event: InstallEvent) => void
  stop: () => void
} {
  const tracker = new ProgressTrackerMultiple()
  let lastBytes = 0
  let lastTime = Date.now()
  let currentSpeed = 0
  let currentLabel = opts.label

  const emit = () => {
    const done = tracker.progress
    const total = tracker.total
    const now = Date.now()
    const dt = now - lastTime
    if (dt >= 400) {
      const delta = Math.max(0, done - lastBytes)
      currentSpeed = Math.round((delta * 1000) / dt)
      lastBytes = done
      lastTime = now
    }
    opts.onProgress?.({
      stage: opts.stage,
      label: currentLabel,
      bytesDone: done,
      bytesTotal: total,
      filesDone: tracker.trackers.filter((t) => t.done).length,
      filesTotal: tracker.trackers.length,
      speed: currentSpeed
    })
  }

  const timer = setInterval(emit, 350)
  const runtime = createDefaultNodeInstallRuntime({
    signal: opts.signal,
    tracker,
    maxConcurrency: opts.maxConcurrency ?? 6
  })

  return {
    runtime,
    onEvent(event) {
      if (event.type === 'task-start') {
        if (event.task.type === 'java') {
          currentLabel = `${opts.label}: обработка загрузчика (Java)`
        } else if (event.task.type === 'materialize') {
          currentLabel = `${opts.label}: подготовка файлов`
        }
        emit()
      } else if (event.type === 'task-end') {
        emit()
      }
    },
    stop() {
      clearInterval(timer)
      emit()
    }
  }
}
