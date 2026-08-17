/**
 * Каталог документов в D1 (§8.2). Ни одного байта пользовательских данных: только размеры,
 * состояния и сроки. Доступ спрятан за интерфейсом — тесты подставляют память вместо D1.
 */
import { C, MS } from '@elementar/proto'
import type { DocState, SigAlg } from '@elementar/proto'
import { fromSqlBlob, toArrayBuffer } from './hash.js'

export const SIG_ALG_CODE: Readonly<Record<SigAlg, number>> = { ed25519: 1, p256: 2 }
export const STATE_CODE: Readonly<Record<DocState, number>> = { active: 0, tombstone: 1, frozen: 2 }
export const CODE_STATE: Readonly<Record<number, DocState>> = {
  0: 'active',
  1: 'tombstone',
  2: 'frozen',
}

export interface CatalogInsert {
  docId: string
  sigAlg: SigAlg
  sigPub: Uint8Array
  app: number
  createdAt: number
  expiresAt: number
}

/** Периодический флаш из DocDO: размеры и сроки, ничего больше. */
export interface CatalogStats {
  docId: string
  state: DocState
  seq: number
  snapshotSeq: number
  snapshotGen: number
  snapshotBytes: number
  snapshotLoc: 0 | 1
  logCount: number
  logBytes: number
  totalBytes: number
  wrapVer: number
  updatedAt: number
  lastSeenAt: number
  expiresAt: number
  deletedAt: number | null
  purgeAfter: number | null
}

export interface GcTask {
  id: string
  stage: number
  attempts: number
  dueAt: number
}

export interface ExpiredDoc {
  docId: string
  state: number
  purgeAfter: number | null
}

export type MetricField =
  | 'docs_created'
  | 'docs_deleted'
  | 'docs_expired'
  | 'deltas_in'
  | 'bytes_in'
  | 'bytes_out'
  | 'ws_opens'
  | 'compactions'
  | 'blocks_issued'
  | 'challenges'
  | 'http_429'
  | 'http_404'

export const METRIC_FIELDS: readonly MetricField[] = [
  'docs_created',
  'docs_deleted',
  'docs_expired',
  'deltas_in',
  'bytes_in',
  'bytes_out',
  'ws_opens',
  'compactions',
  'blocks_issued',
  'challenges',
  'http_429',
  'http_404',
]

export interface Catalog {
  /** Горячий путь: живой (не тумбстон) документ существует? (§9.3) */
  existsActive(docId: string): Promise<boolean>
  /** Тумбстоны тоже видны — нужно только для undelete. */
  existsAny(docId: string): Promise<boolean>
  insertDoc(row: CatalogInsert): Promise<void>
  saveStats(stats: CatalogStats): Promise<void>
  enqueueGc(id: string, dueAt: number): Promise<void>
  dueGc(now: number, limit: number): Promise<GcTask[]>
  advanceGc(id: string, stage: number, dueAt?: number): Promise<void>
  failGc(id: string, dueAt: number, err: string): Promise<void>
  dropGc(id: string): Promise<void>
  expiredDocs(now: number, limit: number): Promise<ExpiredDoc[]>
  deleteDocRow(docId: string): Promise<void>
  bumpMetric(day: string, field: MetricField, by: number): Promise<void>
  readFlags(): Promise<Record<string, string>>
  cleanupBlocks(now: number): Promise<void>
  recordBlock(
    prefixHash: Uint8Array,
    reason: number,
    blockedUntil: number,
    now: number,
  ): Promise<void>
  biggestDocs(limit: number): Promise<Array<{ docId: string; totalBytes: number }>>
}

/** TTL документа по §8.10: пустой — 7 дней, с записями — 365. */
export function expiryFor(lastSeenAt: number, seq: number): number {
  return lastSeenAt + (seq === 0 ? MS.TTL_EMPTY : MS.TTL_ACTIVE)
}

/** Зеркало блокировки живёт не дольше 48 ч (§9.2). */
export const BLOCK_MIRROR_TTL_MS = 48 * 3_600_000

export class D1Catalog implements Catalog {
  constructor(private readonly db: D1Database) {}

  async existsActive(docId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS one FROM docs WHERE id = ? AND state <> 1')
      .bind(docId)
      .first<{ one: number }>()
    return row !== null
  }

  async existsAny(docId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS one FROM docs WHERE id = ?')
      .bind(docId)
      .first<{ one: number }>()
    return row !== null
  }

  async insertDoc(row: CatalogInsert): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO docs (id, sig_alg, sig_pub, app, state, created_at, updated_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        row.docId,
        SIG_ALG_CODE[row.sigAlg],
        toArrayBuffer(row.sigPub),
        row.app,
        row.createdAt,
        row.createdAt,
        row.createdAt,
        row.expiresAt,
      )
      .run()
  }

  async saveStats(s: CatalogStats): Promise<void> {
    await this.db
      .prepare(
        `UPDATE docs SET state = ?, seq = ?, snapshot_seq = ?, snapshot_gen = ?, snapshot_bytes = ?,
           snapshot_loc = ?, log_count = ?, log_bytes = ?, total_bytes = ?, wrap_ver = ?,
           updated_at = ?, last_seen_at = ?, expires_at = ?, deleted_at = ?, purge_after = ?
         WHERE id = ?`,
      )
      .bind(
        STATE_CODE[s.state],
        s.seq,
        s.snapshotSeq,
        s.snapshotGen,
        s.snapshotBytes,
        s.snapshotLoc,
        s.logCount,
        s.logBytes,
        s.totalBytes,
        s.wrapVer,
        s.updatedAt,
        s.lastSeenAt,
        s.expiresAt,
        s.deletedAt,
        s.purgeAfter,
        s.docId,
      )
      .run()
  }

  async enqueueGc(id: string, dueAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO gc_queue (id, stage, attempts, due_at) VALUES (?, 0, 0, ?)
         ON CONFLICT(id) DO UPDATE SET due_at = min(gc_queue.due_at, excluded.due_at)`,
      )
      .bind(id, dueAt)
      .run()
  }

  async dueGc(now: number, limit: number): Promise<GcTask[]> {
    const res = await this.db
      .prepare(
        'SELECT id, stage, attempts, due_at FROM gc_queue WHERE due_at <= ? ORDER BY due_at LIMIT ?',
      )
      .bind(now, limit)
      .all<{ id: string; stage: number; attempts: number; due_at: number }>()
    return res.results.map((r) => ({
      id: r.id,
      stage: r.stage,
      attempts: r.attempts,
      dueAt: r.due_at,
    }))
  }

  async advanceGc(id: string, stage: number, dueAt?: number): Promise<void> {
    if (dueAt === undefined) {
      await this.db
        .prepare('UPDATE gc_queue SET stage = ?, last_err = NULL WHERE id = ?')
        .bind(stage, id)
        .run()
      return
    }
    await this.db
      .prepare('UPDATE gc_queue SET stage = ?, due_at = ?, last_err = NULL WHERE id = ?')
      .bind(stage, dueAt, id)
      .run()
  }

  async failGc(id: string, dueAt: number, err: string): Promise<void> {
    await this.db
      .prepare('UPDATE gc_queue SET attempts = attempts + 1, due_at = ?, last_err = ? WHERE id = ?')
      .bind(dueAt, err.slice(0, 200), id)
      .run()
  }

  async dropGc(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM gc_queue WHERE id = ?').bind(id).run()
  }

  async expiredDocs(now: number, limit: number): Promise<ExpiredDoc[]> {
    const res = await this.db
      .prepare(
        `SELECT id, state, purge_after FROM docs
         WHERE (state = 0 AND expires_at <= ?) OR (state = 1 AND purge_after IS NOT NULL AND purge_after <= ?)
         LIMIT ?`,
      )
      .bind(now, now, limit)
      .all<{ id: string; state: number; purge_after: number | null }>()
    return res.results.map((r) => ({ docId: r.id, state: r.state, purgeAfter: r.purge_after }))
  }

  async deleteDocRow(docId: string): Promise<void> {
    await this.db.prepare('DELETE FROM docs WHERE id = ?').bind(docId).run()
  }

  async bumpMetric(day: string, field: MetricField, by: number): Promise<void> {
    // имя колонки не приходит снаружи: только из METRIC_FIELDS
    await this.db
      .prepare(
        `INSERT INTO metrics_daily (day, ${field}) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
      )
      .bind(day, by)
      .run()
  }

  async readFlags(): Promise<Record<string, string>> {
    const res = await this.db.prepare('SELECT k, v FROM flags').all<{ k: string; v: string }>()
    const out: Record<string, string> = {}
    for (const r of res.results) out[r.k] = r.v
    return out
  }

  async cleanupBlocks(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM abuse_blocks WHERE expires_at <= ?').bind(now).run()
  }

  async recordBlock(
    prefixHash: Uint8Array,
    reason: number,
    blockedUntil: number,
    now: number,
  ): Promise<void> {
    const expiresAt = Math.min(now + BLOCK_MIRROR_TTL_MS, blockedUntil + BLOCK_MIRROR_TTL_MS)
    await this.db
      .prepare(
        `INSERT INTO abuse_blocks (prefix_hash, reason, strikes, blocked_until, expires_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(prefix_hash) DO UPDATE SET strikes = abuse_blocks.strikes + 1,
           reason = excluded.reason, blocked_until = excluded.blocked_until,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .bind(toArrayBuffer(prefixHash), reason, blockedUntil, expiresAt, now)
      .run()
  }

  async biggestDocs(limit: number): Promise<Array<{ docId: string; totalBytes: number }>> {
    const res = await this.db
      .prepare('SELECT id, total_bytes FROM docs WHERE state = 0 ORDER BY total_bytes DESC LIMIT ?')
      .bind(limit)
      .all<{ id: string; total_bytes: number }>()
    return res.results.map((r) => ({ docId: r.id, totalBytes: r.total_bytes }))
  }
}

/** Разбор строки sig_pub из D1 (BLOB → байты) — нужен уборщику и админскому обзору. */
export function sigPubFromRow(v: unknown): Uint8Array {
  return fromSqlBlob(v)
}

/** Потолок документа для отчёта в заголовке квоты (§8.11). */
export const DOC_LIMITS = {
  maxDeltaBytes: C.MAX_DELTA_BYTES,
  maxSnapshotBytes: C.MAX_SNAPSHOT_BYTES,
  maxLogBytes: C.LOG_CEIL_BYTES,
  maxLogCount: C.LOG_CEIL_COUNT,
} as const
