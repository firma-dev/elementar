/**
 * Транспорт WebSocket (§7.4, §8.7): подпись в субпротоколе, heartbeat 25 с с авто-ответом DO,
 * закрытие при молчании 10 с. Бэкоффом и решением «когда подключаться» владеет автомат,
 * здесь только сокет.
 */
import { C, WS_AUTO_PING, WS_AUTO_PONG, WS_BASE, WS_PROTOCOL, encodeMsg, parseServerMsg } from '@elementar/proto'
import type { ClientMsg, ServerMsg, WsHandshake } from '@elementar/proto'
import { formatWsSubprotocols } from '@elementar/proto'
import { Emitter } from '../util/emitter.js'
import type { Unsubscribe } from '../util/emitter.js'

export type TransportPhase = 'idle' | 'connecting' | 'open' | 'closed'

/** Минимум, который нужен от WebSocket: в тестах подставляется фейк. */
export interface WebSocketLike {
  binaryType: string
  readonly readyState: number
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type WsFactory = (url: string, protocols: string[]) => WebSocketLike

export type TransportEvents = {
  open: undefined
  msg: ServerMsg
  /** Бинарный кадр: пакет дельт (§8.4). */
  binary: Uint8Array
  close: { code: number; reason: string }
  error: { message: string }
  /** Кадр, который не разобрался ни как ServerMsg, ни как бинарь. */
  junk: { size: number }
}

export interface TransportOptions {
  url?: string
  /** Хендшейк: since, clientId и подпись (§8.7). */
  handshake: WsHandshake
  ws?: WsFactory
  now?(): number
  heartbeatMs?: number
  heartbeatTimeoutMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export interface Transport {
  readonly phase: TransportPhase
  readonly url: string
  connect(): void
  close(code?: number, reason?: string): void
  /** Текстовый управляющий кадр. */
  send(m: ClientMsg): boolean
  /** Бинарный кадр — пакет дельт. */
  sendBinary(bytes: Uint8Array): boolean
  on<K extends keyof TransportEvents & string>(
    event: K,
    fn: (payload: TransportEvents[K]) => void,
  ): Unsubscribe
}

function defaultFactory(url: string, protocols: string[]): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (u: string, p?: string[]) => unknown }).WebSocket
  if (Ctor === undefined) throw new Error('WebSocket is not available')
  return new Ctor(url, protocols) as WebSocketLike
}

export function wsUrl(docId: string, base: string = WS_BASE): string {
  const origin = (base.endsWith('/') ? base.slice(0, -1) : base).replace(/\/v1$/, '')
  return `${origin}/v1/docs/${docId}/ws`
}

export function createTransport(opts: TransportOptions & { docId?: string }): Transport {
  const url = opts.url ?? wsUrl(opts.docId ?? '')
  const factory = opts.ws ?? defaultFactory
  const now = opts.now ?? Date.now
  const beatMs = opts.heartbeatMs ?? C.HEARTBEAT_MS
  const deadMs = opts.heartbeatTimeoutMs ?? C.HEARTBEAT_TIMEOUT_MS
  const setT = opts.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms))
  const clearT = opts.clearTimer ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>))

  const events = new Emitter<TransportEvents>()
  let sock: WebSocketLike | null = null
  let phase: TransportPhase = 'idle'
  let beat: unknown = null
  let dead: unknown = null
  let lastSeen = 0

  const stopTimers = (): void => {
    if (beat !== null) clearT(beat)
    if (dead !== null) clearT(dead)
    beat = null
    dead = null
  }

  const fail = (code: number, reason: string): void => {
    if (phase === 'closed') return
    stopTimers()
    phase = 'closed'
    const s = sock
    sock = null
    if (s !== null) {
      s.onopen = null
      s.onmessage = null
      s.onclose = null
      s.onerror = null
      try {
        s.close(code, reason)
      } catch {
        /* уже закрыт */
      }
    }
    events.emit('close', { code, reason })
  }

  const armDeadline = (): void => {
    if (dead !== null) clearT(dead)
    dead = setT(() => {
      dead = null
      // молчание дольше таймаута — соединение мертво, автомат уйдёт в BACKOFF
      if (now() - lastSeen >= deadMs) fail(4000, 'heartbeat timeout')
    }, deadMs)
  }

  const armBeat = (): void => {
    if (beat !== null) clearT(beat)
    beat = setT(() => {
      beat = null
      if (phase !== 'open' || sock === null) return
      try {
        sock.send(WS_AUTO_PING)
      } catch {
        fail(4001, 'send failed')
        return
      }
      armDeadline()
      armBeat()
    }, beatMs)
  }

  const onData = (data: unknown): void => {
    lastSeen = now()
    if (dead !== null) {
      clearT(dead)
      dead = null
    }
    if (typeof data === 'string') {
      if (data === WS_AUTO_PONG || data === WS_AUTO_PING) return
      const msg = parseServerMsg(data)
      if (msg === null) {
        events.emit('junk', { size: data.length })
        return
      }
      events.emit('msg', msg)
      return
    }
    if (data instanceof ArrayBuffer) {
      events.emit('binary', new Uint8Array(data))
      return
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView
      events.emit(
        'binary',
        new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength),
      )
      return
    }
    events.emit('junk', { size: 0 })
  }

  return {
    get phase(): TransportPhase {
      return phase
    },
    url,

    connect(): void {
      if (phase === 'connecting' || phase === 'open') return
      phase = 'connecting'
      let s: WebSocketLike
      try {
        s = factory(url, formatWsSubprotocols(opts.handshake))
      } catch (e) {
        phase = 'closed'
        events.emit('error', { message: String(e) })
        events.emit('close', { code: 4002, reason: 'cannot open socket' })
        return
      }
      sock = s
      s.binaryType = 'arraybuffer'
      s.onopen = (): void => {
        phase = 'open'
        lastSeen = now()
        armBeat()
        events.emit('open', undefined)
      }
      s.onmessage = (ev): void => {
        onData(ev.data)
      }
      s.onerror = (): void => {
        events.emit('error', { message: 'socket error' })
      }
      s.onclose = (ev): void => {
        if (phase === 'closed') return
        stopTimers()
        phase = 'closed'
        sock = null
        events.emit('close', { code: ev.code ?? 1006, reason: ev.reason ?? '' })
      }
    },

    close(code = 1000, reason = 'bye'): void {
      if (phase === 'open' && sock !== null) {
        try {
          sock.send(encodeMsg({ t: 'bye' }))
        } catch {
          /* всё равно закрываем */
        }
      }
      fail(code, reason)
    },

    send(m): boolean {
      if (phase !== 'open' || sock === null) return false
      try {
        sock.send(encodeMsg(m))
        return true
      } catch {
        fail(4001, 'send failed')
        return false
      }
    },

    sendBinary(bytes): boolean {
      if (phase !== 'open' || sock === null) return false
      if (bytes.byteLength > C.WS_FRAME_MAX) return false
      try {
        sock.send(bytes)
        return true
      } catch {
        fail(4001, 'send failed')
        return false
      }
    },

    on(event, fn): Unsubscribe {
      return events.on(event, fn as (p: TransportEvents[typeof event]) => void)
    },
  }
}

export { WS_PROTOCOL }
