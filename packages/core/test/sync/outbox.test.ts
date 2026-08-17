import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { C, decodeFrames } from '@elementar/proto'
import { b32encode } from '../../src/crypto/b32.js'
import { openDb } from '../../src/storage/idb.js'
import { DocRepo } from '../../src/storage/repo.js'
import type { OutboxRow } from '../../src/storage/schema.js'
import {
  BEACON_LIMITS,
  WS_LIMITS,
  b32ByteLength,
  createOutbox,
  isDead,
  packBatch,
  packetBytes,
  packetOf,
  retryDelay,
} from '../../src/sync/outbox.js'
import { armBeacon, armedBeacon, flushOutboxBeacon, prepareBeacon } from '../../src/sync/http.js'
import type { HttpEnv } from '../../src/sync/http.js'
import type { Signer } from '../../src/crypto/sign.js'
import type { Op } from '../../src/ops/types.js'

const DOC = 'K7M4Q8XB2NRJ5TWY0CVD'
const CLIENT_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
const HLC = (n: number): string => `${n.toString(16).padStart(12, '0')}-0000-aaaaaaaa`

/** Похожий на настоящий EL1-пакет: кодек кадров проверяет первые три байта. */
function fakePacket(size = 48): string {
  const bytes = new Uint8Array(size)
  bytes[0] = 0x45
  bytes[1] = 0x4c
  bytes[2] = 0x31
  bytes[3] = 0x01
  return b32encode(bytes)
}

function row(n: number, ct = fakePacket()): OutboxRow {
  return { docId: DOC, i: HLC(n), ct, tries: 0, nextAt: 0, clientSeq: n, createdAt: 0 }
}

function op(i: string): Op {
  return { i, k: 's', c: 'tasks', r: 'r0000000000000001', v: { title: 'x' } }
}

const signer: Signer = {
  alg: 'ed25519',
  publicKey: new Uint8Array(32),
  publicKeyB32: b32encode(new Uint8Array(32)),
  sign: async (): Promise<Uint8Array> => new Uint8Array(64),
}

let dbSeq = 0
let repo: DocRepo

beforeEach(async () => {
  dbSeq += 1
  repo = new DocRepo(await openDb({ name: `outbox-test-${dbSeq}` }))
  await repo.ensureDoc({ docId: DOC, corpus: 'planer', schemaVersion: 1, now: 0 })
})

describe('нарезка исходящих', () => {
  it('пачка не длиннее 64 операций (§7.4)', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i + 1))
    expect(packBatch(rows, WS_LIMITS).length).toBe(C.WS_BATCH_OPS)
  })

  it('пачка не толще лимита кадра', () => {
    const big = fakePacket(4096)
    const rows = Array.from({ length: 64 }, (_, i) => row(i + 1, big))
    const batch = packBatch(rows, { maxOps: 64, maxBytes: 10_000 })
    expect(packetBytes(batch)).toBeLessThanOrEqual(10_000)
    expect(batch.length).toBeLessThan(64)
  })

  it('в keepalive уезжает самое старое, остальное ждёт', () => {
    const big = fakePacket(8192)
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, big))
    const batch = packBatch(rows, BEACON_LIMITS)
    expect(packetBytes(batch)).toBeLessThanOrEqual(C.KEEPALIVE_BODY_MAX)
    expect(batch[0]?.clientSeq).toBe(1)
  })

  it('один слишком большой элемент всё равно уезжает один', () => {
    const batch = packBatch([row(1, fakePacket(200_000))], BEACON_LIMITS)
    expect(batch.length).toBe(1)
  })

  it('размер base32 считается без декодирования', () => {
    expect(b32ByteLength(fakePacket(48))).toBe(48)
  })

  it('кадры клиент→сервер имеют нулевые seq и ts', () => {
    const packet = packetOf([row(1), row(2)], CLIENT_ID)
    const decoded = decodeFrames(packet, { direction: 'c2s' })
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.frames.length).toBe(2)
      expect(decoded.frames[0]?.seq).toBe(0)
      expect(decoded.frames[0]?.ts).toBe(0)
      expect(decoded.frames[1]?.clientSeq).toBe(2)
    }
  })

  it('лестница повторов и порог смерти', () => {
    expect(retryDelay(0, () => 0.5)).toBe(1_000)
    expect(retryDelay(99, () => 0.5)).toBe(C.BACKOFF_MAX_MS)
    expect(isDead(12)).toBe(false)
    expect(isDead(13)).toBe(true)
  })
})

describe('очередь поверх хранилища', () => {
  it('ack по assigned закрывает элементы и проставляет seq', async () => {
    const outbox = createOutbox({ repo, docId: DOC, clientId: CLIENT_ID })
    await repo.commitLocal({
      docId: DOC,
      ops: [op(HLC(1)), op(HLC(2))],
      outbox: [
        { i: HLC(1), ct: fakePacket(), clientSeq: 1 },
        { i: HLC(2), ct: fakePacket(), clientSeq: 2 },
      ],
    })
    expect(await outbox.count()).toBe(2)
    const acked = await outbox.ack([
      { clientSeq: 1, seq: 11 },
      { clientSeq: 2, seq: 12 },
    ])
    expect(acked).toBe(2)
    expect(await outbox.count()).toBe(0)
    const ops = await repo.listOps(DOC)
    expect(ops.map((o) => o.seq)).toEqual([11, 12])
  })

  it('повторная отправка тех же clientSeq идемпотентна', async () => {
    const outbox = createOutbox({ repo, docId: DOC, clientId: CLIENT_ID })
    await repo.commitLocal({
      docId: DOC,
      ops: [op(HLC(3))],
      outbox: [{ i: HLC(3), ct: fakePacket(), clientSeq: 5 }],
      now: 0,
    })
    const first = await outbox.take(WS_LIMITS, 0)
    expect(first.length).toBe(1)
    // сервер ответил дубликатом с прежним seq — результат тот же
    expect(await outbox.ack([{ clientSeq: 5, seq: 77 }])).toBe(1)
    expect(await outbox.ack([{ clientSeq: 5, seq: 77 }])).toBe(0)
    expect(await outbox.count()).toBe(0)
  })

  it('неудача откладывает элемент, а не теряет его', async () => {
    const outbox = createOutbox({ repo, docId: DOC, clientId: CLIENT_ID, rnd: () => 0.5 })
    await repo.commitLocal({
      docId: DOC,
      ops: [],
      outbox: [{ i: HLC(4), ct: fakePacket(), clientSeq: 1 }],
      now: 0,
    })
    const rows = await outbox.take(WS_LIMITS, 0)
    await outbox.fail(rows, 0)
    expect(await outbox.take(WS_LIMITS, 500)).toEqual([])
    const later = await outbox.take(WS_LIMITS, 1_000)
    expect(later.length).toBe(1)
    expect(later[0]?.tries).toBe(1)
  })

  it('исчерпавшие попытки уходят из отправки, но остаются в базе', async () => {
    const dead: OutboxRow[][] = []
    const outbox = createOutbox({
      repo,
      docId: DOC,
      clientId: CLIENT_ID,
      rnd: () => 0.5,
      onDead: (rows) => dead.push(rows),
    })
    await repo.commitLocal({
      docId: DOC,
      ops: [],
      outbox: [{ i: HLC(5), ct: fakePacket(), clientSeq: 1 }],
      now: 0,
    })
    for (let i = 0; i <= 12; i++) {
      const rows = await repo.outboxAll(DOC)
      await outbox.fail(rows, 0)
    }
    expect(dead.length).toBe(1)
    expect(await outbox.count()).toBe(0)
    expect((await outbox.all()).length).toBe(1)
  })
})

describe('keepalive-заготовка (§7.5)', () => {
  const env: HttpEnv = {
    docId: DOC,
    docIdBytes: new Uint8Array(12),
    signer,
    base: 'https://s.example/v1',
  }

  afterEach(() => {
    armBeacon(DOC, null)
  })

  it('заготовка подписана заранее и держится наготове', async () => {
    const rows = [row(1), row(2)]
    const beacon = await prepareBeacon(env, rows, CLIENT_ID, 100)
    expect(beacon).not.toBeNull()
    if (beacon === null) return
    expect(beacon.url).toBe(`https://s.example/v1/docs/${DOC}/deltas`)
    expect(beacon.headers['x-elm-sig']?.startsWith('v1,ed25519,')).toBe(true)
    expect(beacon.headers['x-elm-client']).toBe(b32encode(CLIENT_ID))
    expect(beacon.body.length).toBeLessThanOrEqual(C.KEEPALIVE_BODY_MAX)
    armBeacon(DOC, beacon)
    expect(armedBeacon(DOC)).toBe(beacon)
  })

  it('пустая очередь заготовки не даёт', async () => {
    expect(await prepareBeacon(env, [], CLIENT_ID, 0)).toBeNull()
  })

  it('флаш уходит через fetch с keepalive и ничего не бросает', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof fetch
    try {
      const rows = [row(1)]
      const beacon = await prepareBeacon(env, rows, CLIENT_ID, 0)
      armBeacon(DOC, beacon)
      flushOutboxBeacon(DOC, rows)
      expect(calls.length).toBe(1)
      expect(calls[0]?.init.keepalive).toBe(true)
      expect(calls[0]?.init.method).toBe('POST')
      // протухшая заготовка (эти элементы уже подтверждены) не отправляется
      flushOutboxBeacon(DOC, [row(99)])
      expect(calls.length).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  it('без заготовки флаш — просто ничего', () => {
    armBeacon(DOC, null)
    expect(() => flushOutboxBeacon(DOC, [row(1)])).not.toThrow()
  })
})
