import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { CancelledError } from './errors'

export function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const hash = createHash('sha256')
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
    const onAbort = () => stream.destroy(new CancelledError())
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (c) => hash.update(c))
    stream.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

export function sha256Text(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}
