import { beforeEach, describe, expect, it } from 'vitest'
import { IDB_VERSION, OUTBOX_MAX_TRIES, STORE_NAMES } from '../../src/storage/schema.js'
import type { OutboxRow, SecretsRow } from '../../src/storage/schema.js'
import { openDb, tryOpenDb } from '../../src/storage/idb.js'
import { DocRepo } from '../../src/storage/repo.js'
import { shouldAutoExport } from '../../src/storage/persist.js'
import { emptyState } from '../../src/doc/state.js'
import type { WrapRecord } from '@elementar/proto'
import type { Op } from '../../src/ops/types.js'

let dbSeq = 0
async function freshRepo(): Promise<DocRepo> {
  dbSeq += 1
  const db = await openDb({ name: `elementar-test-${dbSeq}` })
  return new DocRepo(db)
}

let repo: DocRepo
const DOC = 'K7M4Q8XB2NRJ5TWY0CVD'

function op(i: string, title: string): Op {
  return { i, k: 's', c: 'tasks', r: 'r0000000000000001', v: { title } }
}

const HLC = (n: number): string => `${n.toString(16).padStart(12, '0')}-0000-aaaaaaaa`

const WRAP: WrapRecord = {
  v: 1,
  wrapVer: 1,
  kdf: { alg: 'none' },
  nonce: '00000000000000000000',
  ct: '0000000000000000000000000000000000000000000000000000000000000000000000000000',
}

beforeEach(async () => {
  repo = await freshRepo()
  await repo.ensureDoc({ docId: DOC, corpus: 'planer', schemaVersion: 1, now: 1_000 })
})

describe('IndexedDB: схема и открытие', () => {
  it('создаются все восемь сторов', async () => {
    const names = [...repo.db.objectStoreNames]
    for (const s of STORE_NAMES) expect(names).toContain(s)
    expect(repo.db.version).toBe(IDB_VERSION)
  })

  it('повторное открытие идемпотентно и не теряет данных', async () => {
    const name = repo.db.name
    await repo.setSetting('actorId', 'abc12345')
    repo.close()
    const again = new DocRepo(await openDb({ name }))
    expect(await again.getSetting<string>('actorId')).toBe('abc12345')
  })

  it('открытие без исключений возвращает результат, а не падает', async () => {
    const res = await tryOpenDb({ name: `elementar-try-${dbSeq}` })
    expect(res.ok).toBe(true)
  })
})

describe('DocRepo: карточки', () => {
  it('ensureDoc не затирает существующую карточку', async () => {
    await repo.patchDoc(DOC, { title: 'Переезд', pinned: true })
    const again = await repo.ensureDoc({ docId: DOC, corpus: 'planer', schemaVersion: 1, now: 5_000 })
    expect(again.title).toBe('Переезд')
    expect(again.pinned).toBe(true)
    expect(again.lastOpenedAt).toBe(5_000)
  })

  it('список отсортирован по последнему открытию', async () => {
    await repo.ensureDoc({ docId: 'B', corpus: 'planer', schemaVersion: 1, now: 9_000 })
    const list = await repo.listDocs()
    expect(list.map((d) => d.docId)).toEqual(['B', DOC])
  })

  it('clientSeq монотонен между вызовами', async () => {
    const a = await repo.nextClientSeq(DOC)
    const b = await repo.nextClientSeq(DOC)
    expect(b).toBe(a + 1)
  })

  it('forget стирает всё, включая ключи', async () => {
    const secrets: SecretsRow = { docId: DOC, mode: 'plain', wrap: WRAP, wrapVer: 1, sigAlg: 'ed25519' }
    await repo.putSecrets(secrets)
    await repo.commitLocal({ docId: DOC, ops: [op(HLC(1), 'x')], outbox: [{ i: HLC(1), ct: 'AA', clientSeq: 1 }] })
    await repo.forgetDoc(DOC)
    expect(await repo.getDoc(DOC)).toBeUndefined()
    expect(await repo.getSecrets(DOC)).toBeUndefined()
    expect(await repo.listOps(DOC)).toEqual([])
    expect(await repo.outboxAll(DOC)).toEqual([])
  })
})

describe('DocRepo: лог и очередь в одной транзакции (§7.4)', () => {
  it('операция попадает и в ops, и в outbox', async () => {
    await repo.commitLocal({
      docId: DOC,
      ops: [op(HLC(1), 'молоко'), op(HLC(2), 'хлеб')],
      outbox: [{ i: HLC(1), ct: 'ABCDEFGH', clientSeq: 1 }],
      now: 2_000,
    })
    expect((await repo.listOps(DOC)).length).toBe(2)
    const queue = await repo.outboxAll(DOC)
    expect(queue.length).toBe(1)
    expect(queue[0]?.tries).toBe(0)
    expect(queue[0]?.nextAt).toBe(2_000)
  })

  it('ack удаляет элемент и проставляет seq операциям', async () => {
    await repo.commitLocal({
      docId: DOC,
      ops: [op(HLC(3), 'a')],
      outbox: [{ i: HLC(3), ct: 'AA', clientSeq: 7 }],
    })
    await repo.markOpsSeq(DOC, [{ i: HLC(3), seq: 42 }])
    await repo.outboxAck(DOC, [HLC(3)])
    expect(await repo.outboxCount(DOC)).toBe(0)
    expect((await repo.listOps(DOC))[0]?.seq).toBe(42)
  })

  it('повторный ack безвреден', async () => {
    await repo.commitLocal({ docId: DOC, ops: [], outbox: [{ i: HLC(4), ct: 'AA', clientSeq: 1 }] })
    await repo.outboxAck(DOC, [HLC(4)])
    await repo.outboxAck(DOC, [HLC(4)])
    expect(await repo.outboxCount(DOC)).toBe(0)
  })

  it('исчерпавший попытки элемент помечается, а не выбрасывается', async () => {
    await repo.commitLocal({ docId: DOC, ops: [], outbox: [{ i: HLC(5), ct: 'AA', clientSeq: 1 }] })
    let dead: OutboxRow[] = []
    for (let i = 0; i <= OUTBOX_MAX_TRIES; i++) {
      dead = await repo.outboxRetry(DOC, [HLC(5)], 10_000)
    }
    expect(dead.length).toBe(1)
    expect(dead[0]?.dead).toBe(true)
    expect((await repo.outboxAll(DOC)).length).toBe(1)
    expect(await repo.outboxCount(DOC)).toBe(0)
  })

  it('due отдаёт только созревшие и живые', async () => {
    await repo.commitLocal({
      docId: DOC,
      ops: [],
      outbox: [
        { i: HLC(6), ct: 'AA', clientSeq: 1 },
        { i: HLC(7), ct: 'BB', clientSeq: 2 },
      ],
      now: 1_000,
    })
    await repo.outboxRetry(DOC, [HLC(7)], 50_000)
    const due = await repo.outboxDue(DOC, 2_000)
    expect(due.map((r) => r.i)).toEqual([HLC(6)])
  })
})

describe('DocRepo: снапшоты (§7.2)', () => {
  it('удерживаются два последних и лог усекается', async () => {
    await repo.commitLocal({ docId: DOC, ops: [op(HLC(10), 'old'), op(HLC(11), 'new')] })
    await repo.markOpsSeq(DOC, [{ i: HLC(10), seq: 5 }])
    const state = emptyState('planer', 1)
    await repo.putSnapshot(DOC, 5, state)
    await repo.putSnapshot(DOC, 6, state)
    await repo.putSnapshot(DOC, 7, state)
    const snaps = await repo.listSnapshots(DOC)
    expect(snaps.map((s) => s.seq)).toEqual([6, 7])
    const ops = await repo.listOps(DOC)
    expect(ops.map((o) => o.i)).toEqual([HLC(11)])
    expect((await repo.getDoc(DOC))?.snapshotSeq).toBe(7)
  })

  it('хвост после снапшота читается отдельно', async () => {
    await repo.commitLocal({ docId: DOC, ops: [op(HLC(20), 'a'), op(HLC(21), 'b')] })
    await repo.markOpsSeq(DOC, [{ i: HLC(20), seq: 3 }])
    const tail = await repo.opsAfter(DOC, 3)
    expect(tail.map((o) => o.i)).toEqual([HLC(21)])
  })

  it('состояние снапшота кладётся structured clone, без JSON', async () => {
    const state = emptyState('planer', 1)
    state.meta['title'] = { v: 'Переезд', t: HLC(1) }
    await repo.putSnapshot(DOC, 1, state)
    const back = await repo.latestSnapshot(DOC)
    expect(back?.state.meta['title']?.v).toBe('Переезд')
    expect(back?.state).not.toBe(state)
  })
})

describe('DocRepo: секреты и журнал', () => {
  it('«не запоминать на устройстве» убирает только linkSecret', async () => {
    await repo.putSecrets({
      docId: DOC,
      mode: 'password',
      linkSecret: new Uint8Array(32).buffer,
      wrap: WRAP,
      wrapVer: 1,
      sigAlg: 'ed25519',
    })
    await repo.forgetLinkSecret(DOC)
    const row = await repo.getSecrets(DOC)
    expect(row?.linkSecret).toBeUndefined()
    expect(row?.wrap.wrapVer).toBe(1)
  })

  it('журнал держит последние 200 событий', async () => {
    for (let i = 0; i < 205; i++) {
      await repo.journal({ at: i, kind: 'sync', message: `e${i}` })
    }
    const rows = await repo.journalList()
    expect(rows.length).toBe(200)
    expect(rows[0]?.message).toBe('e204')
  })
})

describe('квоты и авто-экспорт', () => {
  it('при постоянном хранилище авто-экспорт не нужен', () => {
    expect(shouldAutoExport(true, null, 10_000_000_000)).toBe(false)
  })

  it('без постоянного хранилища — раз в 7 дней', () => {
    const week = 7 * 86_400_000
    expect(shouldAutoExport(false, null, 0)).toBe(true)
    expect(shouldAutoExport(false, 0, week - 1)).toBe(false)
    expect(shouldAutoExport(false, 0, week)).toBe(true)
  })
})
