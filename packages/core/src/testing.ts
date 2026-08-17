/**
 * Фейки для тестов на vitest в приложениях поверх ядра (§7.7).
 * Ничего своего в протокол не добавляет — только сборка настоящего `DocCore`
 * и фейковые края ввода-вывода (WebSocket, fetch), под которые заточен `createSession`.
 */
import type { ServerMsg } from '@elementar/proto'
import { encodeMsg } from '@elementar/proto'
import type { Clock } from './hlc.js'
import { actorId, randomBase62 } from './id.js'
import type { ActorId } from './id.js'
import { createDocCore } from './doc/handle.js'
import type { DocCore } from './doc/handle.js'
import type { DocState } from './doc/state.js'
import type { CollectionsDef, CorpusDef } from './schema/types.js'
import type { FetchLike } from './sync/http.js'
import type { WebSocketLike, WsFactory } from './sync/transport.js'

// ——— документ в памяти ———

export interface TestDocOptions {
  docId?: string
  actor?: ActorId
  clock?: Clock
  state?: DocState
  now?(): number
}

/** Голый `DocCore` без хранилища и сети — для тестов схемы, транзакций и запросов. */
export function createTestDoc<S extends CollectionsDef>(
  def: CorpusDef<S>,
  opts: TestDocOptions = {},
): DocCore<S> {
  return createDocCore<S>({
    def,
    docId: opts.docId ?? randomBase62(16),
    actor: opts.actor ?? actorId(),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    ...(opts.state === undefined ? {} : { state: opts.state }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
}

// ——— два клиента правят офлайн и сливаются ———

export interface OfflinePeersOptions {
  docId?: string
  actorA?: ActorId
  actorB?: ActorId
}

export interface OfflinePeers<S extends CollectionsDef> {
  readonly a: DocCore<S>
  readonly b: DocCore<S>
  /**
   * Слить состояния друг в друга (§6.8): каждый получает снапшот другого таким, каким
   * он был ДО слияния, — `mergeState` коммутативен, так что оба сойдутся к одному стейту.
   */
  merge(): void
  /** `merge()` + проверка, что хеши состояний совпали; иначе кидает исключение. */
  assertConverged(): void
}

/** Два независимых клиента одного документа: правь оба офлайн, потом `merge()`. */
export function createOfflinePeers<S extends CollectionsDef>(
  def: CorpusDef<S>,
  opts: OfflinePeersOptions = {},
): OfflinePeers<S> {
  const docId = opts.docId ?? randomBase62(16)
  const a = createTestDoc<S>(def, { docId, actor: opts.actorA ?? actorId() })
  const b = createTestDoc<S>(def, { docId, actor: opts.actorB ?? actorId() })
  return {
    a,
    b,
    merge(): void {
      const stateA = a._state.value
      const stateB = b._state.value
      a.mergeRemote(stateB)
      b.mergeRemote(stateA)
    },
    assertConverged(): void {
      this.merge()
      const ha = a.stateHash()
      const hb = b.stateHash()
      if (ha !== hb) throw new Error(`клиенты не сошлись после слияния: ${ha} ≠ ${hb}`)
    },
  }
}

// ——— фейковый транспорт: WebSocket ———

export interface FakeSocket extends WebSocketLike {
  readonly url: string
  readonly protocols: readonly string[]
  readonly sent: ReadonlyArray<string | Uint8Array>
  /** Сервер «принял» соединение — как настоящий сокет после открытия TCP. */
  open(): void
  /** Прислать текстовое серверное сообщение протокола (welcome/ack/error/...). */
  deliver(msg: ServerMsg): void
  /** Прислать сырые байты — как бинарный кадр с зашифрованными дельтами. */
  deliverBinary(bytes: Uint8Array): void
  /** Сервер разорвал соединение (или сеть легла). */
  fail(code?: number, reason?: string): void
}

export interface FakeWs {
  /** Передаётся в `createSession({ ws })`. */
  readonly factory: WsFactory
  /** Все сокеты, открытые через фабрику, в порядке создания. */
  readonly sockets: FakeSocket[]
}

/** Управляемая замена `WebSocket`: тест сам решает, когда сокет открылся и что пришло. */
export function createFakeWs(): FakeWs {
  const sockets: FakeSocket[] = []
  const factory: WsFactory = (url, protocols) => {
    const sent: Array<string | Uint8Array> = []
    // readyState в интерфейсе — readonly для потребителя; изнутри фейка меняем через замыкание.
    let readyState = 0
    const socket: FakeSocket = {
      url,
      protocols,
      sent,
      binaryType: 'blob',
      get readyState(): number {
        return readyState
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,

      send(data): void {
        if (typeof data === 'string') {
          sent.push(data)
          return
        }
        const view = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBuffer)
        sent.push(view)
      },

      close(): void {
        readyState = 3
      },

      open(): void {
        readyState = 1
        socket.onopen?.({})
      },

      deliver(msg): void {
        socket.onmessage?.({ data: encodeMsg(msg) })
      },

      deliverBinary(bytes): void {
        socket.onmessage?.({ data: bytes })
      },

      fail(code = 1006, reason = ''): void {
        readyState = 3
        socket.onclose?.({ code, reason })
      },
    }
    sockets.push(socket)
    return socket
  }
  return { factory, sockets }
}

// ——— фейковый транспорт: HTTP ———

export interface FakeFetchCall {
  url: string
  init: RequestInit
}

export type FakeFetchHandler = (call: FakeFetchCall) => Response | Promise<Response>

export interface FakeFetch {
  /** Передаётся в `createSession({ fetch })` / `HttpEnv`. */
  readonly fetch: FetchLike
  readonly calls: FakeFetchCall[]
}

/** Записывает запросы и отвечает тем, что вернёт `handler` (по умолчанию — 200 с `{}`). */
export function createFakeFetch(handler?: FakeFetchHandler): FakeFetch {
  const calls: FakeFetchCall[] = []
  const respond = handler ?? ((): Response => new Response('{}', { status: 200 }))
  const fetch: FetchLike = async (url, init) => {
    const call: FakeFetchCall = { url, init: init ?? {} }
    calls.push(call)
    return respond(call)
  }
  return { fetch, calls }
}

/** Готовый JSON-ответ для `createFakeFetch`: тело + код (по умолчанию 200). */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
