/**
 * Вся правда о документе (§8.3). Класс не знает ни про HTTP, ни про WebSocket, ни про DO —
 * это позволяет гонять сценарии синка, компакции, антиреплея и удаления в обычном тесте.
 *
 * Инварианты: seq монотонен и не переиспользуется; snapshot_seq ≤ seq; клиента с
 * since < snapshot_seq догнать дельтами нельзя; любая запись проходит одним потоком.
 */
import { C, DELTAS_LIMIT_MAX, MS, encodeFrames, formatQuotaHeader } from '@elementar/proto'
import type {
  DeltasQuery,
  DocMeta,
  DocId,
  ElmErrorCode,
  Frame,
  ParsedSigHeader,
  PushResult,
  QuotaHeader,
  SnapshotResult,
  WrapRecord,
} from '@elementar/proto'
import { decodeB32Exact } from '../lib/b32.js'
import { sha256 } from '../lib/hash.js'
import { DOC_LIMITS, expiryFor } from '../lib/catalog.js'
import type { Catalog } from '../lib/catalog.js'
import type { BlobStore } from '../lib/r2.js'
import { verifySignature } from '../http/sig.js'
import type { DocMetaRow, DocStore } from './doc.store.js'
import type { ParsedCreate } from '../lib/validate.js'
import { encodeB32 } from '../lib/b32.js'

export interface CoreFail {
  ok: false
  code: ElmErrorCode
  message: string
  body?: Record<string, number>
}
export type CoreResult<T> = { ok: true; value: T } | CoreFail

function fail(code: ElmErrorCode, message: string, body?: Record<string, number>): CoreFail {
  return body === undefined ? { ok: false, code, message } : { ok: false, code, message, body }
}

export interface DocCoreDeps {
  docId: DocId
  store: DocStore
  blobs: BlobStore
  catalog: Catalog
  now: () => number
}

export interface SigInput {
  method: string
  path: string
  body: Uint8Array
  sig: ParsedSigHeader
  /** Для POST /docs ключ ещё не сохранён — доказательство владения проверяется ключом из тела. */
  sigPub?: Uint8Array
}

export class DocCore {
  private meta: DocMetaRow | null
  private lastSeenAt: number
  dirty = false

  constructor(private readonly deps: DocCoreDeps) {
    this.meta = deps.store.loadMeta()
    this.lastSeenAt = this.meta?.updatedAt ?? 0
  }

  get docId(): DocId {
    return this.deps.docId
  }

  get row(): DocMetaRow | null {
    return this.meta
  }

  exists(): boolean {
    return this.meta !== null
  }

  /** Наружу «нет документа» и «тумбстон» неотличимы (§9.4) — кроме undelete. */
  visible(): boolean {
    return this.meta !== null && this.meta.state !== 'tombstone'
  }

  private docIdBytes(): Uint8Array {
    return decodeB32Exact(this.deps.docId, C.DOC_ID_BYTES) ?? new Uint8Array(C.DOC_ID_BYTES)
  }

  /**
   * Проверка подписи (§4.5): свежесть ts → канон → криптопроверка → персистентный антиреплей.
   * Возвращает код ошибки или null, если всё сошлось.
   */
  async verifySig(input: SigInput): Promise<ElmErrorCode | null> {
    const pub = input.sigPub ?? this.meta?.sigPub
    if (pub === undefined) return 'ELM_NOT_FOUND'
    const bodySha256 = await sha256(input.body)
    const now = this.deps.now()
    const verdict = await verifySignature({
      method: input.method,
      path: input.path,
      docIdBytes: this.docIdBytes(),
      bodySha256,
      alg: input.sig.alg,
      tsMs: input.sig.tsMs,
      sigNonceB32: input.sig.sigNonceB32,
      sigB32: input.sig.sigB32,
      sigPub: pub,
      nowMs: now,
    })
    if (!verdict.ok) return verdict.code
    if (!this.deps.store.markNonce(verdict.nonce, now)) return 'ELM_SIG_REPLAY'
    return null
  }

  // ── метаданные ────────────────────────────────────────────────────────────

  logStats(): { count: number; bytes: number } {
    return this.deps.store.logStats()
  }

  head(): number {
    return this.meta?.seq ?? 0
  }

  /** Граница безопасной компакции (§8.9): min(acked_seq активных за 30 дней, head). */
  safeCompactSeq(): number {
    const head = this.head()
    const acks = this.deps.store.listAcks(this.deps.now() - MS.ACK_WINDOW)
    if (acks.length === 0) return head
    let min = head
    for (const a of acks) min = Math.min(min, a.ackedSeq)
    return Math.max(0, Math.min(min, head))
  }

  compactionNeeded(): boolean {
    const { count, bytes } = this.logStats()
    return count >= C.LOG_SOFT_COUNT || bytes >= C.LOG_SOFT_BYTES
  }

  compactionUrgency(): 'none' | 'soft' | 'hard' {
    const { count, bytes } = this.logStats()
    if (count >= C.LOG_HARD_COUNT || bytes >= C.LOG_HARD_BYTES) return 'hard'
    if (count >= C.LOG_SOFT_COUNT || bytes >= C.LOG_SOFT_BYTES) return 'soft'
    return 'none'
  }

  quota(): QuotaHeader {
    const { count, bytes } = this.logStats()
    return {
      logCount: count,
      logLimit: C.LOG_CEIL_COUNT,
      bytes,
      bytesLimit: C.LOG_CEIL_BYTES,
    }
  }

  quotaHeader(): string {
    return formatQuotaHeader(this.quota())
  }

  expiresAt(): number {
    const m = this.meta
    if (m === null) return 0
    return expiryFor(Math.max(this.lastSeenAt, m.updatedAt), m.seq)
  }

  docMeta(): DocMeta | null {
    const m = this.meta
    if (m === null) return null
    const { count, bytes } = this.logStats()
    const meta: DocMeta = {
      docId: this.deps.docId,
      seq: m.seq,
      snapshotSeq: m.snapshotSeq,
      snapshotGen: m.snapshotGen,
      snapshotBytes: m.snapshotBytes,
      logCount: count,
      logBytes: bytes,
      totalBytes: bytes + m.snapshotBytes,
      wrap: m.wrap,
      wrapVer: m.wrapVer,
      sigAlg: m.sigAlg,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      expiresAt: this.expiresAt(),
      state: m.state,
      limits: { ...DOC_LIMITS },
      compactionNeeded: this.compactionNeeded(),
      safeCompactSeq: this.safeCompactSeq(),
    }
    if (m.deletedAt !== null) meta.deletedAt = m.deletedAt
    return meta
  }

  touch(): void {
    this.lastSeenAt = this.deps.now()
    this.dirty = true
  }

  // ── создание ──────────────────────────────────────────────────────────────

  /**
   * Идемпотентно: повтор с тем же docId и той же sigPub → текущий DocMeta,
   * с другой sigPub → 409 ELM_EXISTS (§8.5).
   */
  async init(req: ParsedCreate): Promise<CoreResult<{ meta: DocMeta; created: boolean }>> {
    const now = this.deps.now()
    const existing = this.meta
    if (existing !== null) {
      const same =
        existing.sigAlg === req.sigAlg && encodeB32(existing.sigPub) === encodeB32(req.sigPubBytes)
      if (!same) return fail('ELM_EXISTS', 'Document id is taken')
      const meta = this.docMeta()
      if (meta === null) return fail('ELM_INTERNAL', 'Broken meta')
      return { ok: true, value: { meta, created: false } }
    }

    const snapshot = req.snapshotBytes
    const row: DocMetaRow = {
      sigAlg: req.sigAlg,
      sigPub: req.sigPubBytes,
      app: req.app ?? 0,
      seq: 0,
      snapshotSeq: 0,
      snapshotGen: snapshot === null ? 0 : 1,
      snapshotBytes: snapshot?.length ?? 0,
      snapshotLoc: 0,
      snapshotR2Key: null,
      logBytes: 0,
      wrap: req.wrap,
      wrapVer: req.wrap.wrapVer,
      createdAt: now,
      updatedAt: now,
      lastSeenFlushedAt: now,
      state: 'active',
      deletedAt: null,
    }
    if (snapshot !== null) this.deps.store.putSnapshot(1, snapshot)
    this.meta = row
    this.lastSeenAt = now
    this.deps.store.saveMeta(row)

    await this.deps.catalog.insertDoc({
      docId: this.deps.docId,
      sigAlg: row.sigAlg,
      sigPub: row.sigPub,
      app: row.app,
      createdAt: now,
      expiresAt: expiryFor(now, 0),
    })
    await this.flush()

    const meta = this.docMeta()
    if (meta === null) return fail('ELM_INTERNAL', 'Broken meta')
    return { ok: true, value: { meta, created: true } }
  }

  // ── чтение дельт ──────────────────────────────────────────────────────────

  getDeltas(q: DeltasQuery): CoreResult<{ packet: Uint8Array; head: number; more: boolean }> {
    const m = this.meta
    if (m === null) return fail('ELM_NOT_FOUND', 'Not found')
    if (q.since < m.snapshotSeq) {
      return fail('ELM_STALE_BASE', 'Behind snapshot', { resyncFrom: m.snapshotSeq })
    }
    const limit = Math.min(Math.max(q.limit, 1), DELTAS_LIMIT_MAX)
    const rows = this.deps.store.listDeltas(q.since, limit)
    const frames: Frame[] = rows.map((r) => ({
      seq: r.seq,
      clientId: r.clientId,
      clientSeq: r.clientSeq,
      ts: r.ts,
      payload: r.payload,
    }))
    const last = rows[rows.length - 1]
    const more = last !== undefined && last.seq < m.seq
    return { ok: true, value: { packet: encodeFrames(frames), head: m.seq, more } }
  }

  // ── запись дельт ──────────────────────────────────────────────────────────

  /** Пакет применяется целиком: либо все кадры приняты, либо ни один (§8.5). */
  pushDeltas(frames: readonly Frame[]): CoreResult<PushResult> {
    const m = this.meta
    if (m === null) return fail('ELM_NOT_FOUND', 'Not found')
    if (m.state === 'tombstone') return fail('ELM_NOT_FOUND', 'Not found')
    if (m.state === 'frozen') return fail('ELM_FROZEN', 'Document is frozen')

    const stats = this.logStats()
    if (stats.count >= C.LOG_CEIL_COUNT || stats.bytes >= C.LOG_CEIL_BYTES) {
      return fail('ELM_QUOTA_LOG_FULL', 'Log is full, snapshot required')
    }

    let incoming = 0
    for (const f of frames) {
      if (f.payload.length > C.MAX_DELTA_BYTES) return fail('ELM_TOO_LARGE', 'Delta too large')
      incoming += f.payload.length
    }
    if (incoming > C.MAX_PACKET_BYTES) return fail('ELM_TOO_LARGE', 'Packet too large')
    if (
      stats.count + frames.length > C.LOG_CEIL_COUNT ||
      stats.bytes + incoming > C.LOG_CEIL_BYTES
    ) {
      return fail('ELM_QUOTA_LOG_FULL', 'Log is full, snapshot required')
    }
    if (stats.bytes + incoming + m.snapshotBytes > C.DOC_TOTAL_BYTES) {
      return fail('ELM_QUOTA_DOC_FULL', 'Document footprint is full')
    }

    const now = this.deps.now()
    const assigned: Array<{ clientSeq: number; seq: number }> = []
    let accepted = 0
    let duplicates = 0

    for (const f of frames) {
      const dup = this.deps.store.findDelta(f.clientId, f.clientSeq)
      if (dup !== null) {
        duplicates++
        assigned.push({ clientSeq: f.clientSeq, seq: dup.seq })
        continue
      }
      const seq = m.seq + 1
      const inserted = this.deps.store.insertDelta({
        seq,
        clientId: f.clientId,
        clientSeq: f.clientSeq,
        ts: now,
        bytes: f.payload.length,
        payload: f.payload,
      })
      if (!inserted) {
        const again = this.deps.store.findDelta(f.clientId, f.clientSeq)
        duplicates++
        assigned.push({ clientSeq: f.clientSeq, seq: again?.seq ?? seq })
        continue
      }
      m.seq = seq
      accepted++
      assigned.push({ clientSeq: f.clientSeq, seq })
    }

    // строка в acks здесь НЕ создаётся: запись ≠ получение чужих дельт. Иначе единственный
    // HTTP-клиент навсегда прижал бы safeCompactSeq к нулю и компакция стала бы невозможна
    // (§8.9: «если единственный активный клиент — сам компактор, safeCompactSeq = head»).
    const after = this.logStats()
    m.logBytes = after.bytes
    m.updatedAt = now
    this.lastSeenAt = now
    this.deps.store.saveMeta(m)
    this.dirty = true

    return {
      ok: true,
      value: {
        accepted,
        duplicates,
        assigned,
        head: m.seq,
        compactionNeeded: this.compactionNeeded(),
        safeCompactSeq: this.safeCompactSeq(),
        logCount: after.count,
        logBytes: after.bytes,
      },
    }
  }

  /** Серверный ack устройства — по нему выбирается компактор (§8.9 п.2). */
  ackedFor(clientId: Uint8Array): number {
    const key = encodeB32(clientId)
    for (const a of this.deps.store.listAcks(0)) {
      if (encodeB32(a.clientId) === key) return a.ackedSeq
    }
    return 0
  }

  /** Подтверждение приёма от устройства — вход в расчёт safeCompactSeq (§8.9). */
  ack(clientId: Uint8Array, upto: number): void {
    const head = this.head()
    this.deps.store.touchAck(clientId, Math.min(upto, head), this.deps.now())
    this.deps.store.evictAcks(C.CLIENT_LRU)
    this.dirty = true
  }

  // ── снапшоты ──────────────────────────────────────────────────────────────

  async putSnapshot(body: Uint8Array, baseSeq: number): Promise<CoreResult<SnapshotResult>> {
    const m = this.meta
    if (m === null) return fail('ELM_NOT_FOUND', 'Not found')
    if (m.state === 'tombstone') return fail('ELM_NOT_FOUND', 'Not found')
    if (body.length > C.MAX_SNAPSHOT_BYTES) return fail('ELM_TOO_LARGE', 'Snapshot too large')
    if (!Number.isSafeInteger(baseSeq) || baseSeq < 0)
      return fail('ELM_BAD_REQUEST', 'Bad base seq')
    if (baseSeq > m.seq)
      return fail('ELM_UNSAFE_BASE', 'Base ahead of head', {
        safeCompactSeq: this.safeCompactSeq(),
      })
    if (baseSeq <= m.snapshotSeq) {
      return fail('ELM_STALE_BASE', 'Snapshot base is stale', { resyncFrom: m.snapshotSeq })
    }
    const safe = this.safeCompactSeq()
    if (baseSeq > safe)
      return fail('ELM_UNSAFE_BASE', 'Peers have not acked yet', { safeCompactSeq: safe })

    const now = this.deps.now()
    const gen = m.snapshotGen + 1
    const inline = body.length <= C.INLINE_SNAPSHOT_BYTES

    if (inline) {
      this.deps.store.putSnapshot(gen, body)
      m.snapshotLoc = 0
      m.snapshotR2Key = null
    } else {
      const digest = await sha256(body)
      await this.deps.blobs.putSnapshot(this.deps.docId, gen, body, {
        seq: baseSeq,
        gen,
        bytes: body.length,
        sha256: encodeB32(digest),
      })
      m.snapshotLoc = 1
      m.snapshotR2Key = `doc/${this.deps.docId}/snap/${gen}.bin`
    }

    // срезанные дельты сначала в корзину R2 на 7 дней, только потом DELETE (§8.9 п.5)
    const pruned = this.deps.store.listDeltasUpTo(baseSeq)
    let prunedDeltas = 0
    if (pruned.length > 0) {
      const first = pruned[0]
      const last = pruned[pruned.length - 1]
      if (first !== undefined && last !== undefined) {
        const packet = encodeFrames(
          pruned.map((r) => ({
            seq: r.seq,
            clientId: r.clientId,
            clientSeq: r.clientSeq,
            ts: r.ts,
            payload: r.payload,
          })),
        )
        await this.deps.blobs.putTrash(this.deps.docId, first.seq, last.seq, packet)
      }
      prunedDeltas = this.deps.store.deleteDeltasUpTo(baseSeq)
    }

    const oldGen = gen - C.SNAPSHOT_GENERATIONS
    if (oldGen > 0) {
      this.deps.store.deleteSnapshot(oldGen)
      await this.deps.catalog.enqueueGc(`${this.deps.docId}#snap${oldGen}`, now)
    }

    m.snapshotSeq = baseSeq
    m.snapshotGen = gen
    m.snapshotBytes = body.length
    m.logBytes = this.logStats().bytes
    m.updatedAt = now
    this.lastSeenAt = now
    this.deps.store.saveMeta(m)
    this.dirty = true
    await this.flush()

    return {
      ok: true,
      value: {
        snapshotSeq: baseSeq,
        snapshotGen: gen,
        bytes: body.length,
        location: inline ? 'do' : 'r2',
        prunedDeltas,
        head: m.seq,
      },
    }
  }

  async getSnapshot(
    gen?: number,
  ): Promise<CoreResult<{ body: Uint8Array; gen: number; seq: number }>> {
    const m = this.meta
    if (m === null || m.state === 'tombstone') return fail('ELM_NOT_FOUND', 'Not found')
    const want = gen ?? m.snapshotGen
    if (want <= 0 || want > m.snapshotGen || want <= m.snapshotGen - C.SNAPSHOT_GENERATIONS) {
      return fail('ELM_NOT_FOUND', 'Not found')
    }
    const inline = this.deps.store.readSnapshot(want)
    if (inline !== null) {
      return { ok: true, value: { body: inline, gen: want, seq: m.snapshotSeq } }
    }
    const fromR2 = await this.deps.blobs.getSnapshot(this.deps.docId, want)
    if (fromR2 === null) return fail('ELM_NOT_FOUND', 'Not found')
    return { ok: true, value: { body: fromR2, gen: want, seq: m.snapshotSeq } }
  }

  // ── wrap, удаление, восстановление ────────────────────────────────────────

  putWrap(wrap: WrapRecord): CoreResult<{ wrapVer: number }> {
    const m = this.meta
    if (m === null || m.state === 'tombstone') return fail('ELM_NOT_FOUND', 'Not found')
    if (m.state === 'frozen') return fail('ELM_FROZEN', 'Document is frozen')
    if (wrap.wrapVer <= m.wrapVer) return fail('ELM_WRAP_STALE', 'wrapVer must grow')
    m.wrap = wrap
    m.wrapVer = wrap.wrapVer
    m.updatedAt = this.deps.now()
    this.lastSeenAt = m.updatedAt
    this.deps.store.saveMeta(m)
    this.dirty = true
    return { ok: true, value: { wrapVer: wrap.wrapVer } }
  }

  /** DELETE → тумбстон. Блобы и лог не трогаются до purge_after (§8.5). */
  async remove(): Promise<CoreResult<{ purgeAfter: number }>> {
    const m = this.meta
    if (m === null || m.state === 'tombstone') return fail('ELM_NOT_FOUND', 'Not found')
    const now = this.deps.now()
    m.state = 'tombstone'
    m.deletedAt = now
    m.updatedAt = now
    this.deps.store.saveMeta(m)
    const purgeAfter = now + MS.TOMBSTONE
    await this.flush(purgeAfter)
    await this.deps.catalog.enqueueGc(this.deps.docId, purgeAfter)
    return { ok: true, value: { purgeAfter } }
  }

  /** Восстановление в течение 7 дней от deletedAt (§8.5). */
  async undelete(): Promise<CoreResult<DocMeta>> {
    const m = this.meta
    if (m === null) return fail('ELM_NOT_FOUND', 'Not found')
    if (m.state !== 'tombstone' || m.deletedAt === null) return fail('ELM_NOT_FOUND', 'Not found')
    const now = this.deps.now()
    if (now > m.deletedAt + MS.TOMBSTONE) return fail('ELM_NOT_FOUND', 'Not found')
    m.state = 'active'
    m.deletedAt = null
    m.updatedAt = now
    this.lastSeenAt = now
    this.deps.store.saveMeta(m)
    await this.deps.catalog.dropGc(this.deps.docId)
    await this.flush()
    const meta = this.docMeta()
    if (meta === null) return fail('ELM_INTERNAL', 'Broken meta')
    return { ok: true, value: meta }
  }

  // ── обслуживание ──────────────────────────────────────────────────────────

  /** Чистка окна антиреплея: старше SIG_NONCE_TTL_MS (§4.5). */
  pruneNonces(): void {
    this.deps.store.pruneNonces(this.deps.now() - C.SIG_NONCE_TTL_MS)
  }

  hasNonces(): boolean {
    return this.deps.store.hasNonces()
  }

  /** Флаш метаданных в D1: по alarm при dirty и синхронно при create/delete/snapshot. */
  async flush(purgeAfter: number | null = null): Promise<void> {
    const m = this.meta
    if (m === null) return
    const { count, bytes } = this.logStats()
    const lastSeen = Math.max(this.lastSeenAt, m.updatedAt)
    await this.deps.catalog.saveStats({
      docId: this.deps.docId,
      state: m.state,
      seq: m.seq,
      snapshotSeq: m.snapshotSeq,
      snapshotGen: m.snapshotGen,
      snapshotBytes: m.snapshotBytes,
      snapshotLoc: m.snapshotLoc,
      logCount: count,
      logBytes: bytes,
      totalBytes: bytes + m.snapshotBytes,
      wrapVer: m.wrapVer,
      updatedAt: m.updatedAt,
      lastSeenAt: lastSeen,
      expiresAt: expiryFor(lastSeen, m.seq),
      deletedAt: m.deletedAt,
      purgeAfter:
        purgeAfter ??
        (m.state === 'tombstone' && m.deletedAt !== null ? m.deletedAt + MS.TOMBSTONE : null),
    })
    m.lastSeenFlushedAt = lastSeen
    this.deps.store.saveMeta(m)
    this.dirty = false
  }

  /** Полное стирание (дренаж gc_queue, §8.10). */
  destroy(): void {
    this.deps.store.deleteAll()
    this.meta = null
  }
}
