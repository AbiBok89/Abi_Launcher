import { resolveSrv } from 'node:dns/promises'
import { createConnection } from 'node:net'
import type { ServerStatus } from '@shared/types'

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

function readVarInt(buf: Buffer, offset: number): { value: number; bytesRead: number } | null {
  let numRead = 0
  let result = 0
  while (true) {
    if (offset + numRead >= buf.length) return null
    const read = buf[offset + numRead]
    result |= (read & 0x7f) << (7 * numRead)
    numRead++
    if (numRead > 5) throw new Error('Некорректный VarInt в ответе сервера')
    if ((read & 0x80) === 0) break
  }
  return { value: result, bytesRead: numRead }
}

function buildHandshakeAndRequest(host: string, port: number): Buffer {
  const hostBuf = Buffer.from(host, 'utf8')
  const portBuf = Buffer.allocUnsafe(2)
  portBuf.writeUInt16BE(port, 0)

  const handshakePayload = Buffer.concat([
    Buffer.from([0x00]), // Packet ID: Handshake
    writeVarInt(-1), // Protocol version (-1: запрос статуса)
    writeVarInt(hostBuf.length),
    hostBuf,
    portBuf,
    Buffer.from([0x01]) // Next state: Status
  ])

  const handshakePacket = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload])
  const statusRequest = Buffer.from([0x01, 0x00])
  return Buffer.concat([handshakePacket, statusRequest])
}

function stripColorCodes(text: string): string {
  return text.replace(/§[0-9a-fklmnorx]/gi, '').replace(/\s+/g, ' ').trim()
}

function extractPlainDescription(desc: unknown, depth = 0): string {
  if (depth > 8 || desc == null) return ''
  if (typeof desc === 'string') return desc
  if (Array.isArray(desc)) return desc.map((x) => extractPlainDescription(x, depth + 1)).join('')
  if (typeof desc === 'object') {
    const obj = desc as { text?: unknown; translate?: unknown; extra?: unknown }
    let out = typeof obj.text === 'string' ? obj.text : typeof obj.translate === 'string' ? obj.translate : ''
    if (Array.isArray(obj.extra)) {
      out += obj.extra.map((x) => extractPlainDescription(x, depth + 1)).join('')
    }
    return out
  }
  return ''
}

function offlineStatus(error: string): ServerStatus {
  return {
    online: false,
    playersOnline: null,
    playersMax: null,
    version: null,
    motd: null,
    latencyMs: null,
    error
  }
}

export async function pingMinecraftServer(
  host: string,
  port?: number,
  timeoutMs = 5000
): Promise<ServerStatus> {
  const cleanHost = host.trim()
  if (!cleanHost || !/^[A-Za-z0-9.-]{1,253}$/.test(cleanHost)) {
    return offlineStatus('Некорректный адрес сервера')
  }

  let targetHost = cleanHost
  let targetPort = port ?? 25565

  if (port === undefined) {
    try {
      const records = await resolveSrv(`_minecraft._tcp.${cleanHost}`)
      if (records.length > 0 && records[0].name) {
        targetHost = records[0].name.replace(/\.$/, '')
        targetPort = records[0].port || 25565
      }
    } catch {
      /* SRV не обязателен */
    }
  }

  return new Promise<ServerStatus>((resolve) => {
    let settled = false
    const startTime = Date.now()
    let connectLatency = 0
    let chunks: Buffer[] = []
    let totalBytes = 0
    const MAX_RESPONSE_BYTES = 512 * 1024

    const socket = createConnection({ host: targetHost, port: targetPort })
    socket.setTimeout(timeoutMs)

    const finish = (status: ServerStatus) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(status)
    }

    socket.on('connect', () => {
      connectLatency = Date.now() - startTime
      socket.write(buildHandshakeAndRequest(cleanHost, targetPort))
    })

    socket.on('data', (chunk) => {
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bufChunk.length
      if (totalBytes > MAX_RESPONSE_BYTES) {
        finish(offlineStatus('Слишком большой ответ сервера'))
        return
      }
      chunks.push(bufChunk)
      const buf = Buffer.concat(chunks)

      try {
        const packetLen = readVarInt(buf, 0)
        if (!packetLen) return
        if (buf.length < packetLen.bytesRead + packetLen.value) return

        let offset = packetLen.bytesRead
        const packetId = readVarInt(buf, offset)
        if (!packetId) return
        offset += packetId.bytesRead
        if (packetId.value !== 0x00) {
          finish(offlineStatus(`Неожиданный код пакета: ${packetId.value}`))
          return
        }

        const jsonLen = readVarInt(buf, offset)
        if (!jsonLen) return
        offset += jsonLen.bytesRead
        if (buf.length < offset + jsonLen.value) return

        const jsonStr = buf.subarray(offset, offset + jsonLen.value).toString('utf8')
        const parsed = JSON.parse(jsonStr) as {
          version?: { name?: unknown }
          players?: { online?: unknown; max?: unknown }
          description?: unknown
        }

        const motdRaw = extractPlainDescription(parsed.description)
        const motd = stripColorCodes(motdRaw) || null

        finish({
          online: true,
          playersOnline: typeof parsed.players?.online === 'number' ? parsed.players.online : null,
          playersMax: typeof parsed.players?.max === 'number' ? parsed.players.max : null,
          version: typeof parsed.version?.name === 'string' ? stripColorCodes(parsed.version.name) : null,
          motd,
          latencyMs: connectLatency,
          error: null
        })
      } catch (e) {
        finish(offlineStatus(`Некорректный ответ сервера: ${(e as Error).message}`))
      }
    })

    socket.on('timeout', () => finish(offlineStatus('Превышено время ожидания ответа (5 с)')))
    socket.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED') finish(offlineStatus('Сервер отклонил подключение (выключен)'))
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') finish(offlineStatus('Адрес сервера не найден'))
      else finish(offlineStatus(`Ошибка подключения${code ? ` (${code})` : ''}`))
    })
    socket.on('end', () => {
      finish(offlineStatus('Сервер закрыл соединение до отправки статуса'))
    })
  })
}
