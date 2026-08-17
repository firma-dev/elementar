import { beforeEach, describe, expect, it } from 'vitest'
import { encodeMsg } from '@elementar/proto'
import type { PushResult, ServerMsg } from '@elementar/proto'
import { b32encode } from '../../src/crypto/b32.js'
import { generateDocKey } from '../../src/crypto/keys.js'
import { createNonceSource } from '../../src/crypto/nonce.js'
import type { Signer } from '../../src/crypto/sign.js'
import { createDocCore } from '../../src/doc/handle.js'
import type { DocCore } from '../../src/doc/handle.js'
import { defineCorpus, f } from '../../src/schema/define.js'
import { openDb } from '../../src/storage/idb.js'
import { DocRepo } from '../../src/storage/repo.js'
import { createSession, eventForCode } from '../../src/sync/session.js'
import type { Session } from '../../src/sync/session.js'
import type { WebSocketLike } from '../../src/sync/transport.js'

const PLANER = defineCorpus({
  id: 'planer',
  schemaVersion: 1,
  collections: {
    task: {
      ordered: true,
      label: (t): string => t.title,
      fields: { title: f.text({ max: 200 }), done: f.bool(false) },
    },
  },
})

const DOC = 'K7M4Q8XB2NRJ5TWY0CVD'
const CLIENT_ID = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2])
const DOC_ID_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

const signer: Signer = {
  alg: 'ed25519',
  publicKey: new Uint8Array(32),
  publicKeyB32: b32encode(new Uint8Array(32)),
  sign: async (): Promise<Uint8Array> => new Uint8Array(64),
}

/** Управляемый сокет: тест сам решает, когда он открылся и что прислал. */
class FakeSocket implements WebSocketLike {
  binaryType = 'blob'
  readyState = 0
  readonly sent: Array<string | Uint8Array> = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(
      typeof data === 'string'
        ? data
        : new Uint8Array(
            ArrayBuffer.isView(data)
              ? (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength)
              : (data as ArrayBuffer),
          ),
    )
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  deliver(msg: ServerMsg): void {
    this.onmessage?.({ data: encodeMsg(msg) })
  }
}

interface Rig {
  session: Session
  core: DocCore<(typeof PLANER)['collections']>
  repo: DocRepo
  sockets: FakeSocket[]
  requests: Array<{ url: string; init: RequestInit }>
  timers: Array<() => void>
  runTimers(): void
}

let dbSeq = 0
let pushResult: PushResult

async function rig(opts: { sync?: boolean } = {}): Promise<Rig> {
  dbSeq += 1
  const repo = new DocRepo(await openDb({ name: `session-test-${dbSeq}` }))
  await repo.ensureDoc({ docId: DOC, corpus: 'planer', schemaVersion: 1, now: 0 })
  const core = createDocCore({ def: PLANER, docId: DOC, actor: 'aaaa1111' })
  const sockets: FakeSocket[] = []
  const requests: Array<{ url: string; init: RequestInit }> = []
  const timers: Array<() => void> = []

  const session = createSession({
    core,
    repo,
    docId: DOC,
    docIdBytes: DOC_ID_BYTES,
    key: generateDocKey(),
    nonce: createNonceSource(),
    signer,
    clientId: CLIENT_ID,
    sync: opts.sync ?? true,
    base: 'https://s.example/v1',
    wsUrl: 'wss://s.example/v1/docs/x/ws',
    listen: false,
    ws: (url, protocols): WebSocketLike => {
      const s = new FakeSocket(url, protocols)
      sockets.push(s)
      return s
    },
    fetch: (url, init): Promise<Response> => {
      requests.push({ url, init: init ?? {} })
      return Promise.resolve(
        new Response(JSON.stringify(pushResult), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    },
    setTimer: (fn): unknown => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: (): void => undefined,
  })

  return {
    session,
    core,
    repo,
    sockets,
    requests,
    timers,
    runTimers: (): void => {
      const pendingTimers = [...timers]
      timers.length = 0
      for (const t of pendingTimers) t()
    },
  }
}

/** Дать асинхронной шифровке и записи в IDB доехать. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 1))
}

beforeEach(() => {
  pushResult = {
    accepted: 1,
    duplicates: 0,
    assigned: [{ clientSeq: 1, seq: 1 }],
    head: 1,
    compactionNeeded: false,
    safeCompactSeq: 1,
    logCount: 1,
    logBytes: 100,
  }
})

describe('сессия: локальная правка', () => {
  it('правка сразу ложится в лог и очередь одной транзакцией', async () => {
    const r = await rig({ sync: false })
    await r.session.start()
    r.core.tx((t) => {
      t.col.task.create({ title: 'Собрать коробки' })
    })
    await settle()
    const ops = await r.repo.listOps(DOC)
    const queue = await r.repo.outboxAll(DOC)
    expect(ops.length).toBeGreaterThan(0)
    expect(queue.length).toBe(1)
    expect(queue[0]?.ct.length).toBeGreaterThan(0)
    expect(r.session.machine.pending).toBe(1)
    await r.session.close()
  })

  it('без сети правки копятся, а flush отправляет их по HTTP', async () => {
    const r = await rig({ sync: false })
    await r.session.start()
    r.core.tx((t) => {
      t.col.task.create({ title: 'Заказать машину' })
    })
    await settle()
    await r.session.flush()
    await settle()
    const post = r.requests.find((q) => q.init.method === 'POST')
    expect(post?.url).toBe(`https://s.example/v1/docs/${DOC}/deltas`)
    expect(await r.repo.outboxCount(DOC)).toBe(0)
    expect(r.session.machine.pending).toBe(0)
    await r.session.close()
  })

  it('перезапуск сессии поднимает состояние из снапшота и хвоста лога', async () => {
    const r = await rig({ sync: false })
    await r.session.start()
    r.core.tx((t) => {
      t.col.task.create({ title: 'Коробки' })
    })
    await settle()
    await r.session.snapshot()
    await r.session.close()

    const core2 = createDocCore({ def: PLANER, docId: DOC, actor: 'aaaa1111' })
    const again = createSession({
      core: core2,
      repo: r.repo,
      docId: DOC,
      docIdBytes: DOC_ID_BYTES,
      key: generateDocKey(),
      nonce: createNonceSource(),
      signer,
      clientId: CLIENT_ID,
      sync: false,
      listen: false,
    })
    await again.start()
    expect(core2.col.task.all.value.map((t) => t.title)).toEqual(['Коробки'])
    await again.close()
  })
})

describe('сессия: парный режим', () => {
  it('welcome переводит в catchup и подписывает на дельты', async () => {
    const r = await rig()
    await r.session.start()
    await settle()
    const sock = r.sockets[0]
    expect(sock).toBeDefined()
    if (sock === undefined) return
    expect(sock.protocols[0]).toBe('elm.v1')
    sock.open()
    sock.deliver({
      t: 'welcome',
      head: 0,
      snapshotSeq: 0,
      snapshotGen: 0,
      sessionId: 's1',
      peers: [],
      compactionNeeded: false,
      safeCompactSeq: 0,
      serverTime: 1,
    })
    await settle()
    expect(r.session.machine.phase).toBe('live')
    expect(sock.sent.some((m) => typeof m === 'string' && m.includes('"sub"'))).toBe(true)
    await r.session.close()
  })

  it('правка в live уезжает бинарным кадром, ack чистит очередь', async () => {
    const r = await rig()
    await r.session.start()
    await settle()
    const sock = r.sockets[0]
    if (sock === undefined) throw new Error('нет сокета')
    sock.open()
    sock.deliver({
      t: 'welcome',
      head: 0,
      snapshotSeq: 0,
      snapshotGen: 0,
      sessionId: 's1',
      peers: [],
      compactionNeeded: false,
      safeCompactSeq: 0,
      serverTime: 1,
    })
    await settle()
    r.core.tx((t) => {
      t.col.task.create({ title: 'Коробки' })
    })
    await settle()
    const binary = sock.sent.filter((m) => m instanceof Uint8Array)
    expect(binary.length).toBe(1)
    expect((binary[0] as Uint8Array)[0]).toBe(0xe1)

    sock.deliver({
      t: 'ack',
      assigned: [{ clientSeq: 1, seq: 1 }],
      head: 1,
      duplicates: 0,
      compactionNeeded: false,
      safeCompactSeq: 1,
    })
    await settle()
    expect(await r.repo.outboxCount(DOC)).toBe(0)
    expect(r.session.machine.pending).toBe(0)
    await r.session.close()
  })

  it('bye с кодом «не найдено» уводит в DENIED без переподключений', async () => {
    const r = await rig()
    await r.session.start()
    await settle()
    const sock = r.sockets[0]
    if (sock === undefined) throw new Error('нет сокета')
    sock.open()
    sock.deliver({ t: 'bye', code: 'ELM_NOT_FOUND' })
    await settle()
    expect(r.session.machine.phase).toBe('denied')
    expect(r.session.status.value.error?.code).toBe('ELM_NOT_FOUND')
    await r.session.close()
  })
})

describe('сессия: коды ошибок в события', () => {
  it('404 и битая подпись — доступа нет', () => {
    expect(eventForCode('ELM_NOT_FOUND', 0).t).toBe('ERR_AUTH')
    expect(eventForCode('ELM_SIG_INVALID', 0).t).toBe('ERR_AUTH')
  })

  it('429 несёт паузу от сервера', () => {
    const e = eventForCode('ELM_RATE_LIMITED', 0, 5_000)
    expect(e.t).toBe('ERR_RATE')
    if (e.t === 'ERR_RATE') expect(e.retryAfterMs).toBe(5_000)
  })

  it('всё прочее — обычная ошибка с бэкоффом', () => {
    expect(eventForCode('ELM_INTERNAL', 0).t).toBe('ERR_OTHER')
    expect(eventForCode('ELM_NETWORK', 0).t).toBe('ERR_OTHER')
  })
})
