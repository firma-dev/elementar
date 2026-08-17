/**
 * DocRepo: снапшот, лог, outbox, секреты, вложения, настройки, журнал (§7.1, §7.2, §7.4).
 *
 * Ключевое обещание §7.4: операция попадает в `ops` и в `outbox` в ОДНОЙ транзакции
 * вместе с обновлением карточки. Пропасть между «показал на экране» и «сохранил» невозможна.
 */
import type { DocCard } from '../schema/types.js'
import type { HlcString } from '../hlc.js'
import type { DocState } from '../doc/state.js'
import type { AnyOp } from '../ops/types.js'
import { opBytes } from '../ops/codec.js'
import {
  IDX,
  JOURNAL_LIMIT,
  OUTBOX_MAX_TRIES,
  SNAPSHOT_KEEP,
  STORE,
} from './schema.js'
import type {
  BlobRow,
  DocRow,
  JournalRow,
  OpRow,
  OutboxRow,
  SecretsRow,
  SettingRow,
  SnapshotRow,
} from './schema.js'
import { del, docRange, getAll, getAllFromIndex, getOne, put, req, withTx } from './idb.js'

export interface NewDoc {
  docId: string
  corpus: string
  title?: string
  schemaVersion: number
  app?: number
  sync?: boolean
  linkPersistState?: DocRow['linkPersistState']
  now?: number
}

/** Что уходит в лог и в очередь за одну транзакцию. */
export interface CommitLocal {
  docId: string
  ops: readonly AnyOp[]
  /** Готовые EL1-пакеты: по одному на пачку операций. */
  outbox?: ReadonlyArray<{ i: HlcString; ct: string; clientSeq: number }>
  now?: number
}

export function docCardOf(row: DocRow): DocCard {
  return {
    docId: row.docId,
    corpus: row.corpus,
    title: row.title,
    schemaVersion: row.schemaVersion,
    seq: row.seq,
    lastOpenedAt: row.lastOpenedAt,
    pinned: row.pinned,
  }
}

export class DocRepo {
  readonly db: IDBDatabase

  constructor(db: IDBDatabase) {
    this.db = db
  }

  // ——— карточки документов ———

  async listDocs(): Promise<DocCard[]> {
    const rows = await withTx(this.db, STORE.docs, 'readonly', (tx) =>
      getAllFromIndex<DocRow>(tx, STORE.docs, IDX.docsByOpened),
    )
    return rows.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).map(docCardOf)
  }

  async getDoc(docId: string): Promise<DocRow | undefined> {
    return withTx(this.db, STORE.docs, 'readonly', (tx) => getOne<DocRow>(tx, STORE.docs, docId))
  }

  async putDoc(row: DocRow): Promise<void> {
    await withTx(this.db, STORE.docs, 'readwrite', async (tx) => {
      await put(tx, STORE.docs, row)
    })
  }

  /** Карточка нового документа; повторный вызов не затирает уже существующую. */
  async ensureDoc(init: NewDoc): Promise<DocRow> {
    const now = init.now ?? Date.now()
    return withTx(this.db, STORE.docs, 'readwrite', async (tx) => {
      const existing = await getOne<DocRow>(tx, STORE.docs, init.docId)
      if (existing !== undefined) {
        const touched: DocRow = { ...existing, lastOpenedAt: now }
        await put(tx, STORE.docs, touched)
        return touched
      }
      const row: DocRow = {
        docId: init.docId,
        corpus: init.corpus,
        title: init.title ?? '',
        schemaVersion: init.schemaVersion,
        seq: 0,
        snapshotSeq: 0,
        lastOpenedAt: now,
        createdAt: now,
        pinned: false,
        sync: init.sync ?? true,
        linkPersistState: init.linkPersistState ?? 'unsaved',
        clientSeq: 0,
      }
      if (init.app !== undefined) row.app = init.app
      await put(tx, STORE.docs, row)
      return row
    })
  }

  async patchDoc(docId: string, patch: Partial<Omit<DocRow, 'docId'>>): Promise<DocRow | undefined> {
    return withTx(this.db, STORE.docs, 'readwrite', async (tx) => {
      const row = await getOne<DocRow>(tx, STORE.docs, docId)
      if (row === undefined) return undefined
      const next: DocRow = { ...row, ...patch, docId }
      await put(tx, STORE.docs, next)
      return next
    })
  }

  /** Следующий clientSeq: монотонен и переживает перезагрузку — от него зависит идемпотентность. */
  async nextClientSeq(docId: string, count = 1): Promise<number> {
    return withTx(this.db, STORE.docs, 'readwrite', async (tx) => {
      const row = await getOne<DocRow>(tx, STORE.docs, docId)
      if (row === undefined) return 0
      const first = row.clientSeq + 1
      await put(tx, STORE.docs, { ...row, clientSeq: row.clientSeq + Math.max(1, count) })
      return first
    })
  }

  /** Документ забыт на этом устройстве: стираются все следы, включая ключи. */
  async forgetDoc(docId: string): Promise<void> {
    await withTx(
      this.db,
      [STORE.docs, STORE.snapshots, STORE.ops, STORE.outbox, STORE.secrets, STORE.blobs],
      'readwrite',
      async (tx) => {
        await del(tx, STORE.docs, docId)
        await del(tx, STORE.secrets, docId)
        await del(tx, STORE.snapshots, docRange(docId))
        await del(tx, STORE.ops, docRange(docId))
        await del(tx, STORE.outbox, docRange(docId))
        await del(tx, STORE.blobs, docRange(docId))
      },
    )
  }

  // ——— снапшоты ———

  async latestSnapshot(docId: string): Promise<SnapshotRow | undefined> {
    const rows = await withTx(this.db, STORE.snapshots, 'readonly', (tx) =>
      getAll<SnapshotRow>(tx, STORE.snapshots, docRange(docId)),
    )
    let best: SnapshotRow | undefined
    for (const r of rows) if (best === undefined || r.seq > best.seq) best = r
    return best
  }

  async listSnapshots(docId: string): Promise<SnapshotRow[]> {
    const rows = await withTx(this.db, STORE.snapshots, 'readonly', (tx) =>
      getAll<SnapshotRow>(tx, STORE.snapshots, docRange(docId)),
    )
    return rows.sort((a, b) => a.seq - b.seq)
  }

  /**
   * Запись снапшота (§7.2): удерживаются два последних, локальный лог усекается до seq.
   * Всё в одной транзакции, иначе сбой между шагами оставит документ без хвоста лога.
   */
  async putSnapshot(
    docId: string,
    seq: number,
    state: DocState,
    opts: { pruneLog?: boolean; savedAt?: number } = {},
  ): Promise<SnapshotRow> {
    const savedAt = opts.savedAt ?? Date.now()
    const row: SnapshotRow = { docId, seq, state, savedAt }
    return withTx(
      this.db,
      [STORE.snapshots, STORE.ops, STORE.docs],
      'readwrite',
      async (tx) => {
        await put(tx, STORE.snapshots, row)
        const all = await getAll<SnapshotRow>(tx, STORE.snapshots, docRange(docId))
        const stale = all.sort((a, b) => b.seq - a.seq).slice(SNAPSHOT_KEEP)
        for (const s of stale) await del(tx, STORE.snapshots, [docId, s.seq])
        if (opts.pruneLog !== false) {
          const ops = await getAll<OpRow>(tx, STORE.ops, docRange(docId))
          for (const o of ops) {
            if (o.seq !== undefined && o.seq <= seq) await del(tx, STORE.ops, [docId, o.i])
          }
        }
        const card = await getOne<DocRow>(tx, STORE.docs, docId)
        if (card !== undefined) {
          await put(tx, STORE.docs, { ...card, snapshotSeq: seq, seq: Math.max(card.seq, seq) })
        }
        return row
      },
    )
  }

  // ——— лог ———

  async listOps(docId: string): Promise<OpRow[]> {
    const rows = await withTx(this.db, STORE.ops, 'readonly', (tx) =>
      getAll<OpRow>(tx, STORE.ops, docRange(docId)),
    )
    return rows.sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : 0))
  }

  /** Хвост лога после снапшота: то, что надо доиграть поверх загруженного состояния. */
  async opsAfter(docId: string, seq: number): Promise<OpRow[]> {
    const rows = await this.listOps(docId)
    return rows.filter((r) => r.seq === undefined || r.seq > seq)
  }

  async appendOps(docId: string, ops: readonly AnyOp[], at = Date.now()): Promise<void> {
    if (ops.length === 0) return
    await withTx(this.db, STORE.ops, 'readwrite', async (tx) => {
      for (const op of ops) {
        const row: OpRow = { docId, i: op.i, op, bytes: opBytes(op), at }
        await put(tx, STORE.ops, row)
      }
    })
  }

  /** Проставить серверный seq подтверждённым операциям. */
  async markOpsSeq(docId: string, pairs: ReadonlyArray<{ i: HlcString; seq: number }>): Promise<void> {
    if (pairs.length === 0) return
    await withTx(this.db, STORE.ops, 'readwrite', async (tx) => {
      for (const p of pairs) {
        const row = await getOne<OpRow>(tx, STORE.ops, [docId, p.i])
        if (row === undefined) continue
        await put(tx, STORE.ops, { ...row, seq: p.seq })
      }
    })
  }

  // ——— исходящая очередь ———

  async outboxAll(docId: string): Promise<OutboxRow[]> {
    const rows = await withTx(this.db, STORE.outbox, 'readonly', (tx) =>
      getAll<OutboxRow>(tx, STORE.outbox, docRange(docId)),
    )
    return rows.sort((a, b) => a.clientSeq - b.clientSeq)
  }

  async outboxDue(docId: string, now = Date.now()): Promise<OutboxRow[]> {
    const rows = await this.outboxAll(docId)
    return rows.filter((r) => r.dead !== true && r.nextAt <= now)
  }

  async outboxCount(docId: string): Promise<number> {
    const rows = await this.outboxAll(docId)
    return rows.filter((r) => r.dead !== true).length
  }

  /**
   * Один атомарный коммит локальной правки: лог + очередь + карточка (§7.4).
   * Возвращает записанные строки очереди — их сразу можно отдать транспорту.
   */
  async commitLocal(c: CommitLocal): Promise<OutboxRow[]> {
    const now = c.now ?? Date.now()
    return withTx(this.db, [STORE.ops, STORE.outbox, STORE.docs], 'readwrite', async (tx) => {
      for (const op of c.ops) {
        const row: OpRow = { docId: c.docId, i: op.i, op, bytes: opBytes(op), at: now }
        await put(tx, STORE.ops, row)
      }
      const written: OutboxRow[] = []
      for (const item of c.outbox ?? []) {
        const row: OutboxRow = {
          docId: c.docId,
          i: item.i,
          ct: item.ct,
          tries: 0,
          nextAt: now,
          clientSeq: item.clientSeq,
          createdAt: now,
        }
        await put(tx, STORE.outbox, row)
        written.push(row)
      }
      const card = await getOne<DocRow>(tx, STORE.docs, c.docId)
      if (card !== undefined) {
        const maxSeq = written.reduce((m, r) => Math.max(m, r.clientSeq), card.clientSeq)
        await put(tx, STORE.docs, { ...card, clientSeq: maxSeq, lastOpenedAt: now })
      }
      return written
    })
  }

  async enqueue(rows: readonly OutboxRow[]): Promise<void> {
    if (rows.length === 0) return
    await withTx(this.db, STORE.outbox, 'readwrite', async (tx) => {
      for (const r of rows) await put(tx, STORE.outbox, r)
    })
  }

  /** ack: элементы удаляются по своему id. Повтор ack безвреден. */
  async outboxAck(docId: string, ids: readonly HlcString[]): Promise<void> {
    if (ids.length === 0) return
    await withTx(this.db, STORE.outbox, 'readwrite', async (tx) => {
      for (const i of ids) await del(tx, STORE.outbox, [docId, i])
    })
  }

  /** Неудача отправки: попытка засчитана, следующая — не раньше nextAt. */
  async outboxRetry(
    docId: string,
    ids: readonly HlcString[],
    nextAt: number,
  ): Promise<OutboxRow[]> {
    if (ids.length === 0) return []
    return withTx(this.db, STORE.outbox, 'readwrite', async (tx) => {
      const dead: OutboxRow[] = []
      for (const i of ids) {
        const row = await getOne<OutboxRow>(tx, STORE.outbox, [docId, i])
        if (row === undefined) continue
        const tries = row.tries + 1
        const next: OutboxRow = { ...row, tries, nextAt }
        if (tries > OUTBOX_MAX_TRIES) {
          next.dead = true
          dead.push(next)
        }
        await put(tx, STORE.outbox, next)
      }
      return dead
    })
  }

  // ——— секреты ———

  async getSecrets(docId: string): Promise<SecretsRow | undefined> {
    return withTx(this.db, STORE.secrets, 'readonly', (tx) =>
      getOne<SecretsRow>(tx, STORE.secrets, docId),
    )
  }

  async putSecrets(row: SecretsRow): Promise<void> {
    await withTx(this.db, STORE.secrets, 'readwrite', async (tx) => {
      await put(tx, STORE.secrets, row)
    })
  }

  /** Снять «запомнить на этом устройстве»: ключ ссылки уходит, wrap остаётся (§5.4). */
  async forgetLinkSecret(docId: string): Promise<void> {
    const row = await this.getSecrets(docId)
    if (row === undefined) return
    const next: SecretsRow = { ...row }
    delete next.linkSecret
    await this.putSecrets(next)
  }

  // ——— вложения ———

  async putBlob(row: BlobRow): Promise<void> {
    await withTx(this.db, STORE.blobs, 'readwrite', async (tx) => {
      await put(tx, STORE.blobs, row)
    })
  }

  async getBlob(docId: string, blobId: string): Promise<BlobRow | undefined> {
    return withTx(this.db, STORE.blobs, 'readonly', (tx) =>
      getOne<BlobRow>(tx, STORE.blobs, [docId, blobId]),
    )
  }

  async listBlobs(docId: string): Promise<BlobRow[]> {
    return withTx(this.db, STORE.blobs, 'readonly', (tx) =>
      getAll<BlobRow>(tx, STORE.blobs, docRange(docId)),
    )
  }

  async deleteBlob(docId: string, blobId: string): Promise<void> {
    await withTx(this.db, STORE.blobs, 'readwrite', async (tx) => {
      await del(tx, STORE.blobs, [docId, blobId])
    })
  }

  // ——— настройки устройства ———

  async getSetting<T>(key: string): Promise<T | undefined> {
    const row = await withTx(this.db, STORE.settings, 'readonly', (tx) =>
      getOne<SettingRow>(tx, STORE.settings, key),
    )
    return row === undefined ? undefined : (row.value as T)
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await withTx(this.db, STORE.settings, 'readwrite', async (tx) => {
      await put(tx, STORE.settings, { key, value } satisfies SettingRow)
    })
  }

  // ——— журнал ———

  async journal(entry: Omit<JournalRow, 'id'>): Promise<void> {
    await withTx(this.db, STORE.journal, 'readwrite', async (tx) => {
      await put(tx, STORE.journal, entry)
      const store = tx.objectStore(STORE.journal)
      const count = await req(store.count())
      if (count <= JOURNAL_LIMIT) return
      const extra = count - JOURNAL_LIMIT
      const rows = await getAllFromIndex<JournalRow>(tx, STORE.journal, IDX.journalByTime, undefined, extra)
      for (const r of rows) if (r.id !== undefined) await del(tx, STORE.journal, r.id)
    })
  }

  async journalList(limit = JOURNAL_LIMIT): Promise<JournalRow[]> {
    const rows = await withTx(this.db, STORE.journal, 'readonly', (tx) =>
      getAll<JournalRow>(tx, STORE.journal),
    )
    return rows.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  close(): void {
    this.db.close()
  }
}

export function createRepo(db: IDBDatabase): DocRepo {
  return new DocRepo(db)
}
