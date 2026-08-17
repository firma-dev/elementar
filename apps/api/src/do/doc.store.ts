/**
 * Хранилище DocDO (§8.3). Интерфейс отделён от SQLite ради тестов: в проде — ctx.storage.sql,
 * в юнит-тестах — та же семантика в памяти. Сервер не разбирает ни одного байта payload.
 */
import type { DocState, SigAlg, WrapRecord } from '@elementar/proto'
import { fromSqlBlob, toArrayBuffer } from '../lib/hash.js'
import { decodeB32, encodeB32 } from '../lib/b32.js'

export interface DocMetaRow {
  sigAlg: SigAlg
  sigPub: Uint8Array
  app: number
  seq: number
  snapshotSeq: number
  snapshotGen: number
  snapshotBytes: number
  /** 0 = внутри DO, 1 = R2. */
  snapshotLoc: 0 | 1
  snapshotR2Key: string | null
  logBytes: number
  wrap: WrapRecord
  wrapVer: number
  createdAt: number
  updatedAt: number
  lastSeenFlushedAt: number
  state: DocState
  deletedAt: number | null
}

export interface DeltaRow {
  seq: number
  clientId: Uint8Array
  clientSeq: number
  ts: number
  bytes: number
  payload: Uint8Array
}

export interface AckRow {
  clientId: Uint8Array
  ackedSeq: number
  at: number
}

export interface DocStore {
  loadMeta(): DocMetaRow | null
  saveMeta(meta: DocMetaRow): void
  /** false — дубль по (client_id, client_seq): вся идемпотентность синка (§8.3). */
  insertDelta(row: DeltaRow): boolean
  findDelta(clientId: Uint8Array, clientSeq: number): DeltaRow | null
  listDeltas(sinceExclusive: number, limit: number): DeltaRow[]
  listDeltasUpTo(seqInclusive: number): DeltaRow[]
  deleteDeltasUpTo(seqInclusive: number): number
  logStats(): { count: number; bytes: number }
  putSnapshot(gen: number, body: Uint8Array): void
  readSnapshot(gen: number): Uint8Array | null
  deleteSnapshot(gen: number): void
  /** true — nonce виден впервые (и записан); false — реплей. */
  markNonce(nonce: Uint8Array, at: number): boolean
  pruneNonces(before: number): void
  hasNonces(): boolean
  touchAck(clientId: Uint8Array, ackedSeq: number, at: number): void
  listAcks(activeSince: number): AckRow[]
  /** LRU по clientId без заморозки (§8.8): лишние строки acks просто вытесняются. */
  evictAcks(max: number): void
  deleteAll(): void
}

export const SNAP_CHUNK_BYTES = 65_536

const utf8 = new TextEncoder()
const utf8d = new TextDecoder()

const META_KEYS = [
  'init',
  'sig_alg',
  'sig_pub',
  'app',
  'seq',
  'snapshot_seq',
  'snapshot_gen',
  'snapshot_bytes',
  'snapshot_loc',
  'snapshot_r2_key',
  'log_bytes',
  'wrap',
  'wrap_ver',
  'created_at',
  'updated_at',
  'last_seen_flushed_at',
  'state',
  'deleted_at',
] as const

function metaToRecord(m: DocMetaRow): Record<string, string> {
  return {
    init: '1',
    sig_alg: m.sigAlg,
    sig_pub: encodeB32(m.sigPub),
    app: String(m.app),
    seq: String(m.seq),
    snapshot_seq: String(m.snapshotSeq),
    snapshot_gen: String(m.snapshotGen),
    snapshot_bytes: String(m.snapshotBytes),
    snapshot_loc: String(m.snapshotLoc),
    snapshot_r2_key: m.snapshotR2Key ?? '',
    log_bytes: String(m.logBytes),
    wrap: JSON.stringify(m.wrap),
    wrap_ver: String(m.wrapVer),
    created_at: String(m.createdAt),
    updated_at: String(m.updatedAt),
    last_seen_flushed_at: String(m.lastSeenFlushedAt),
    state: m.state,
    deleted_at: m.deletedAt === null ? '' : String(m.deletedAt),
  }
}

export const DOC_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);

CREATE TABLE IF NOT EXISTS deltas (
  seq        INTEGER PRIMARY KEY,
  client_id  BLOB    NOT NULL,
  client_seq INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  payload    BLOB    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_deltas_client ON deltas (client_id, client_seq);

CREATE TABLE IF NOT EXISTS snap_chunks (
  gen INTEGER NOT NULL, idx INTEGER NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY (gen, idx)
);

CREATE TABLE IF NOT EXISTS sig_nonces (nonce BLOB PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sig_nonces_seen ON sig_nonces (seen_at);

CREATE TABLE IF NOT EXISTS acks (
  client_id BLOB PRIMARY KEY,
  acked_seq INTEGER NOT NULL,
  at        INTEGER NOT NULL
);
`

type SqlDeltaRaw = {
  seq: number
  client_id: ArrayBuffer
  client_seq: number
  ts: number
  bytes: number
  payload: ArrayBuffer
} & Record<string, SqlStorageValue>

export class SqlDocStore implements DocStore {
  private cache: Record<string, string> = {}

  constructor(private readonly sql: SqlStorage) {
    for (const stmt of DOC_SCHEMA.split(';')) {
      const s = stmt.trim()
      if (s.length > 0) this.sql.exec(s)
    }
  }

  loadMeta(): DocMetaRow | null {
    const rows = this.sql
      .exec<{ k: string; v: ArrayBuffer | string }>('SELECT k, v FROM meta')
      .toArray()
    const rec: Record<string, string> = {}
    for (const r of rows)
      rec[r.k] = typeof r.v === 'string' ? r.v : utf8d.decode(new Uint8Array(r.v))
    this.cache = rec
    if (rec['init'] !== '1') return null
    return recordToMeta(rec)
  }

  saveMeta(meta: DocMetaRow): void {
    const rec = metaToRecord(meta)
    for (const k of META_KEYS) {
      const v = rec[k] ?? ''
      if (this.cache[k] === v) continue
      this.sql.exec(
        'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        k,
        toArrayBuffer(utf8.encode(v)),
      )
      this.cache[k] = v
    }
  }

  insertDelta(row: DeltaRow): boolean {
    if (this.findDelta(row.clientId, row.clientSeq) !== null) return false
    this.sql.exec(
      'INSERT INTO deltas (seq, client_id, client_seq, ts, bytes, payload) VALUES (?, ?, ?, ?, ?, ?)',
      row.seq,
      toArrayBuffer(row.clientId),
      row.clientSeq,
      row.ts,
      row.bytes,
      toArrayBuffer(row.payload),
    )
    return true
  }

  findDelta(clientId: Uint8Array, clientSeq: number): DeltaRow | null {
    const rows = this.sql
      .exec<SqlDeltaRaw>(
        'SELECT seq, client_id, client_seq, ts, bytes, payload FROM deltas WHERE client_id = ? AND client_seq = ?',
        toArrayBuffer(clientId),
        clientSeq,
      )
      .toArray()
    const r = rows[0]
    return r === undefined ? null : toDelta(r)
  }

  listDeltas(sinceExclusive: number, limit: number): DeltaRow[] {
    return this.sql
      .exec<SqlDeltaRaw>(
        'SELECT seq, client_id, client_seq, ts, bytes, payload FROM deltas WHERE seq > ? ORDER BY seq LIMIT ?',
        sinceExclusive,
        limit,
      )
      .toArray()
      .map(toDelta)
  }

  listDeltasUpTo(seqInclusive: number): DeltaRow[] {
    return this.sql
      .exec<SqlDeltaRaw>(
        'SELECT seq, client_id, client_seq, ts, bytes, payload FROM deltas WHERE seq <= ? ORDER BY seq',
        seqInclusive,
      )
      .toArray()
      .map(toDelta)
  }

  deleteDeltasUpTo(seqInclusive: number): number {
    const before = this.logStats().count
    this.sql.exec('DELETE FROM deltas WHERE seq <= ?', seqInclusive)
    return before - this.logStats().count
  }

  logStats(): { count: number; bytes: number } {
    const r = this.sql
      .exec<{ n: number; b: number | null }>('SELECT count(*) AS n, sum(bytes) AS b FROM deltas')
      .toArray()[0]
    return { count: r?.n ?? 0, bytes: r?.b ?? 0 }
  }

  putSnapshot(gen: number, body: Uint8Array): void {
    this.sql.exec('DELETE FROM snap_chunks WHERE gen = ?', gen)
    for (let i = 0, idx = 0; i < body.length; i += SNAP_CHUNK_BYTES, idx++) {
      this.sql.exec(
        'INSERT INTO snap_chunks (gen, idx, payload) VALUES (?, ?, ?)',
        gen,
        idx,
        toArrayBuffer(body.slice(i, i + SNAP_CHUNK_BYTES)),
      )
    }
  }

  readSnapshot(gen: number): Uint8Array | null {
    const rows = this.sql
      .exec<{ payload: ArrayBuffer }>(
        'SELECT payload FROM snap_chunks WHERE gen = ? ORDER BY idx',
        gen,
      )
      .toArray()
    if (rows.length === 0) return null
    const parts = rows.map((r) => new Uint8Array(r.payload))
    let total = 0
    for (const p of parts) total += p.length
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  deleteSnapshot(gen: number): void {
    this.sql.exec('DELETE FROM snap_chunks WHERE gen = ?', gen)
  }

  markNonce(nonce: Uint8Array, at: number): boolean {
    const buf = toArrayBuffer(nonce)
    const seen = this.sql
      .exec<{ one: number }>('SELECT 1 AS one FROM sig_nonces WHERE nonce = ?', buf)
      .toArray()
    if (seen.length > 0) return false
    this.sql.exec('INSERT INTO sig_nonces (nonce, seen_at) VALUES (?, ?)', buf, at)
    return true
  }

  pruneNonces(before: number): void {
    this.sql.exec('DELETE FROM sig_nonces WHERE seen_at < ?', before)
  }

  hasNonces(): boolean {
    return (
      (this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM sig_nonces').toArray()[0]?.n ?? 0) >
      0
    )
  }

  touchAck(clientId: Uint8Array, ackedSeq: number, at: number): void {
    this.sql.exec(
      `INSERT INTO acks (client_id, acked_seq, at) VALUES (?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET acked_seq = max(acks.acked_seq, excluded.acked_seq), at = excluded.at`,
      toArrayBuffer(clientId),
      ackedSeq,
      at,
    )
  }

  listAcks(activeSince: number): AckRow[] {
    return this.sql
      .exec<{ client_id: ArrayBuffer; acked_seq: number; at: number }>(
        'SELECT client_id, acked_seq, at FROM acks WHERE at >= ?',
        activeSince,
      )
      .toArray()
      .map((r) => ({ clientId: new Uint8Array(r.client_id), ackedSeq: r.acked_seq, at: r.at }))
  }

  evictAcks(max: number): void {
    this.sql.exec(
      'DELETE FROM acks WHERE client_id NOT IN (SELECT client_id FROM acks ORDER BY at DESC LIMIT ?)',
      max,
    )
  }

  deleteAll(): void {
    for (const t of ['meta', 'deltas', 'snap_chunks', 'sig_nonces', 'acks']) {
      this.sql.exec(`DELETE FROM ${t}`)
    }
    this.cache = {}
  }
}

function toDelta(r: SqlDeltaRaw): DeltaRow {
  return {
    seq: r.seq,
    clientId: fromSqlBlob(r.client_id),
    clientSeq: r.client_seq,
    ts: r.ts,
    bytes: r.bytes,
    payload: fromSqlBlob(r.payload),
  }
}

function recordToMeta(rec: Record<string, string>): DocMetaRow | null {
  const sigAlg = rec['sig_alg']
  if (sigAlg !== 'ed25519' && sigAlg !== 'p256') return null
  const state = rec['state']
  if (state !== 'active' && state !== 'frozen' && state !== 'tombstone') return null
  const pub = decodeB32(rec['sig_pub'] ?? '') ?? new Uint8Array(0)
  let wrap: WrapRecord
  try {
    wrap = JSON.parse(rec['wrap'] ?? '{}') as WrapRecord
  } catch {
    return null
  }
  const num = (k: string): number => Number(rec[k] ?? '0')
  const r2 = rec['snapshot_r2_key'] ?? ''
  const del = rec['deleted_at'] ?? ''
  return {
    sigAlg,
    sigPub: pub,
    app: num('app'),
    seq: num('seq'),
    snapshotSeq: num('snapshot_seq'),
    snapshotGen: num('snapshot_gen'),
    snapshotBytes: num('snapshot_bytes'),
    snapshotLoc: num('snapshot_loc') === 1 ? 1 : 0,
    snapshotR2Key: r2 === '' ? null : r2,
    logBytes: num('log_bytes'),
    wrap,
    wrapVer: num('wrap_ver'),
    createdAt: num('created_at'),
    updatedAt: num('updated_at'),
    lastSeenFlushedAt: num('last_seen_flushed_at'),
    state,
    deletedAt: del === '' ? null : Number(del),
  }
}

/** Реализация в памяти с той же семантикой — тесты и dev без SQLite. */
export class MemoryDocStore implements DocStore {
  private meta: DocMetaRow | null = null
  private readonly deltas = new Map<number, DeltaRow>()
  private readonly byClient = new Map<string, number>()
  private readonly snaps = new Map<number, Uint8Array>()
  private readonly nonces = new Map<string, number>()
  private readonly acks = new Map<string, AckRow>()

  loadMeta(): DocMetaRow | null {
    return this.meta
  }

  saveMeta(meta: DocMetaRow): void {
    this.meta = { ...meta, sigPub: meta.sigPub.slice(), wrap: { ...meta.wrap } }
  }

  insertDelta(row: DeltaRow): boolean {
    const key = clientKey(row.clientId, row.clientSeq)
    if (this.byClient.has(key)) return false
    this.deltas.set(row.seq, {
      ...row,
      clientId: row.clientId.slice(),
      payload: row.payload.slice(),
    })
    this.byClient.set(key, row.seq)
    return true
  }

  findDelta(clientId: Uint8Array, clientSeq: number): DeltaRow | null {
    const seq = this.byClient.get(clientKey(clientId, clientSeq))
    return seq === undefined ? null : (this.deltas.get(seq) ?? null)
  }

  listDeltas(sinceExclusive: number, limit: number): DeltaRow[] {
    return [...this.deltas.values()]
      .filter((d) => d.seq > sinceExclusive)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
  }

  listDeltasUpTo(seqInclusive: number): DeltaRow[] {
    return [...this.deltas.values()]
      .filter((d) => d.seq <= seqInclusive)
      .sort((a, b) => a.seq - b.seq)
  }

  deleteDeltasUpTo(seqInclusive: number): number {
    let n = 0
    for (const d of [...this.deltas.values()]) {
      if (d.seq <= seqInclusive) {
        this.deltas.delete(d.seq)
        this.byClient.delete(clientKey(d.clientId, d.clientSeq))
        n++
      }
    }
    return n
  }

  logStats(): { count: number; bytes: number } {
    let bytes = 0
    for (const d of this.deltas.values()) bytes += d.bytes
    return { count: this.deltas.size, bytes }
  }

  putSnapshot(gen: number, body: Uint8Array): void {
    this.snaps.set(gen, body.slice())
  }

  readSnapshot(gen: number): Uint8Array | null {
    return this.snaps.get(gen) ?? null
  }

  deleteSnapshot(gen: number): void {
    this.snaps.delete(gen)
  }

  markNonce(nonce: Uint8Array, at: number): boolean {
    const k = encodeB32(nonce)
    if (this.nonces.has(k)) return false
    this.nonces.set(k, at)
    return true
  }

  pruneNonces(before: number): void {
    for (const [k, at] of [...this.nonces]) if (at < before) this.nonces.delete(k)
  }

  hasNonces(): boolean {
    return this.nonces.size > 0
  }

  touchAck(clientId: Uint8Array, ackedSeq: number, at: number): void {
    const k = encodeB32(clientId)
    const prev = this.acks.get(k)
    this.acks.set(k, {
      clientId: clientId.slice(),
      ackedSeq: Math.max(prev?.ackedSeq ?? 0, ackedSeq),
      at,
    })
  }

  listAcks(activeSince: number): AckRow[] {
    return [...this.acks.values()].filter((a) => a.at >= activeSince)
  }

  evictAcks(max: number): void {
    const sorted = [...this.acks.entries()].sort((a, b) => b[1].at - a[1].at)
    for (const [k] of sorted.slice(max)) this.acks.delete(k)
  }

  deleteAll(): void {
    this.meta = null
    this.deltas.clear()
    this.byClient.clear()
    this.snaps.clear()
    this.nonces.clear()
    this.acks.clear()
  }

  /** Только для теста слепоты: полный дамп всего, что DO держит на диске. */
  dumpAll(): unknown[] {
    return [
      this.meta,
      [...this.deltas.values()],
      [...this.snaps.entries()],
      [...this.nonces.keys()],
      [...this.acks.values()],
    ]
  }
}

function clientKey(clientId: Uint8Array, clientSeq: number): string {
  return `${encodeB32(clientId)}:${clientSeq}`
}
