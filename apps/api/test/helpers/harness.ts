/**
 * Мок окружения Worker'а без сети и без workerd: память вместо D1, R2, Cache API и DO.
 * Считает обращения к DocDO — на этом держится проверка «неизвестный id не инстанцирует DO».
 */
import {
  ALLOWED_ORIGIN,
  C,
  PATHS,
  canonicalSigInput,
  encodeFrames,
  formatSigHeader,
} from '@elementar/proto'
import type { DocId, Frame, SigAlg, WrapRecord } from '@elementar/proto'
import { encodeB32 } from '../../src/lib/b32.js'
import { sha256 } from '../../src/lib/hash.js'
import { DocCore } from '../../src/do/doc.core.js'
import { MemoryDocStore } from '../../src/do/doc.store.js'
import { NO_HOOKS, handleDocHttp } from '../../src/do/doc.http.js'
import { DOC_ID_HEADER } from '../../src/do/doc.http.js'
import type {
  Catalog,
  CatalogInsert,
  CatalogStats,
  ExpiredDoc,
  GcTask,
  MetricField,
} from '../../src/lib/catalog.js'
import type { BlobStore, SnapshotMeta } from '../../src/lib/r2.js'
import { snapKey, trashKey } from '../../src/lib/r2.js'
import { MemoryExists, MemoryPenalty } from '../../src/http/exists.js'
import { LocalLimiter } from '../../src/lib/limiter.client.js'
import { DisabledTurnstile } from '../../src/http/turnstile.js'
import { DEFAULT_FLAGS } from '../../src/lib/flags.js'
import type { Flags } from '../../src/lib/flags.js'
import type { Services, Stub, StubHost } from '../../src/services.js'

export const HOST = 'https://s.elementar.example'

// ── каталог в памяти ────────────────────────────────────────────────────────

export interface CatalogRow extends Partial<CatalogStats> {
  docId: string
  sigAlg: SigAlg
  sigPub: Uint8Array
  app: number
  createdAt: number
  expiresAt: number
  state: 'active' | 'frozen' | 'tombstone'
}

export class MemoryCatalog implements Catalog {
  readonly docs = new Map<string, CatalogRow>()
  readonly gc = new Map<string, GcTask>()
  readonly metrics = new Map<string, number>()
  readonly blocks = new Map<string, { until: number; expiresAt: number }>()
  flags: Record<string, string> = {
    accept_creates: '1',
    accept_writes: '1',
    llm_relay: '1',
    challenge_mode: '0',
  }

  async existsActive(docId: string): Promise<boolean> {
    const row = this.docs.get(docId)
    return row !== undefined && row.state !== 'tombstone'
  }
  async existsAny(docId: string): Promise<boolean> {
    return this.docs.has(docId)
  }
  async insertDoc(row: CatalogInsert): Promise<void> {
    if (this.docs.has(row.docId)) return
    this.docs.set(row.docId, { ...row, state: 'active' })
  }
  async saveStats(s: CatalogStats): Promise<void> {
    const cur = this.docs.get(s.docId)
    if (cur === undefined) return
    this.docs.set(s.docId, { ...cur, ...s, state: s.state })
  }
  async enqueueGc(id: string, dueAt: number): Promise<void> {
    this.gc.set(id, { id, stage: 0, attempts: 0, dueAt })
  }
  async dueGc(now: number, limit: number): Promise<GcTask[]> {
    return [...this.gc.values()].filter((t) => t.dueAt <= now).slice(0, limit)
  }
  async advanceGc(id: string, stage: number, dueAt?: number): Promise<void> {
    const t = this.gc.get(id)
    if (t !== undefined) this.gc.set(id, { ...t, stage, dueAt: dueAt ?? t.dueAt })
  }
  async failGc(id: string, dueAt: number): Promise<void> {
    const t = this.gc.get(id)
    if (t !== undefined) this.gc.set(id, { ...t, attempts: t.attempts + 1, dueAt })
  }
  async dropGc(id: string): Promise<void> {
    this.gc.delete(id)
  }
  async expiredDocs(now: number, limit: number): Promise<ExpiredDoc[]> {
    return [...this.docs.values()]
      .filter((d) => (d.expiresAt ?? 0) <= now)
      .slice(0, limit)
      .map((d) => ({
        docId: d.docId,
        state: d.state === 'tombstone' ? 1 : 0,
        purgeAfter: d.purgeAfter ?? null,
      }))
  }
  async deleteDocRow(docId: string): Promise<void> {
    this.docs.delete(docId)
  }
  async bumpMetric(day: string, field: MetricField, by: number): Promise<void> {
    const k = `${day}:${field}`
    this.metrics.set(k, (this.metrics.get(k) ?? 0) + by)
  }
  async readFlags(): Promise<Record<string, string>> {
    return this.flags
  }
  async cleanupBlocks(now: number): Promise<void> {
    for (const [k, v] of [...this.blocks]) if (v.expiresAt <= now) this.blocks.delete(k)
  }
  async recordBlock(
    prefixHash: Uint8Array,
    _reason: number,
    blockedUntil: number,
    now: number,
  ): Promise<void> {
    this.blocks.set(encodeB32(prefixHash), { until: blockedUntil, expiresAt: now + 48 * 3_600_000 })
  }
  async biggestDocs(limit: number): Promise<Array<{ docId: string; totalBytes: number }>> {
    return [...this.docs.values()]
      .map((d) => ({ docId: d.docId, totalBytes: d.totalBytes ?? 0 }))
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, limit)
  }
}

// ── R2 в памяти ─────────────────────────────────────────────────────────────

export class MemoryBlobs implements BlobStore {
  readonly objects = new Map<string, { body: Uint8Array; uploaded: number; meta?: SnapshotMeta }>()
  constructor(private readonly now: () => number = Date.now) {}

  async putSnapshot(
    docId: string,
    gen: number,
    body: Uint8Array,
    meta: SnapshotMeta,
  ): Promise<void> {
    this.objects.set(snapKey(docId, gen), { body, uploaded: this.now(), meta })
  }
  async getSnapshot(docId: string, gen: number): Promise<Uint8Array | null> {
    return this.objects.get(snapKey(docId, gen))?.body ?? null
  }
  async deleteSnapshot(docId: string, gen: number): Promise<void> {
    this.objects.delete(snapKey(docId, gen))
  }
  async putTrash(docId: string, fromSeq: number, toSeq: number, body: Uint8Array): Promise<void> {
    this.objects.set(trashKey(docId, fromSeq, toSeq), { body, uploaded: this.now() })
  }
  async deleteDoc(docId: string): Promise<void> {
    for (const k of [...this.objects.keys()])
      if (k.startsWith(`doc/${docId}/`)) this.objects.delete(k)
  }
  async list(prefix: string, limit: number): Promise<Array<{ key: string; uploaded: number }>> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .slice(0, limit)
      .map(([key, v]) => ({ key, uploaded: v.uploaded }))
  }
  async delete(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k)
  }
}

// ── DocDO в памяти ──────────────────────────────────────────────────────────

export class TestDocs implements StubHost {
  /** Сколько раз вообще брали ссылку на DocDO: для §9.6 п.5 это обязано быть нулём. */
  instantiations = 0
  readonly stores = new Map<string, MemoryDocStore>()

  constructor(
    private readonly catalog: Catalog,
    private readonly blobs: BlobStore,
    private readonly now: () => number,
  ) {}

  store(docId: string): MemoryDocStore {
    let s = this.stores.get(docId)
    if (s === undefined) {
      s = new MemoryDocStore()
      this.stores.set(docId, s)
    }
    return s
  }

  /** Каждый вызов строит DocCore заново — это и есть эвикция/хибернация DO. */
  core(docId: string): DocCore {
    return new DocCore({
      docId: docId as DocId,
      store: this.store(docId),
      blobs: this.blobs,
      catalog: this.catalog,
      now: this.now,
    })
  }

  get(docId: string): Stub {
    this.instantiations += 1
    return {
      fetch: (request: Request): Promise<Response> =>
        handleDocHttp(this.core(docId), request, docId as DocId, ALLOWED_ORIGIN, NO_HOOKS),
    }
  }
}

/** InviteDO в памяти: TTL 15 минут, ровно одно использование. */
export class TestInvites implements StubHost {
  readonly records = new Map<string, { blob: string; expiresAt: number }>()
  constructor(private readonly now: () => number) {}

  get(iid: string): Stub {
    return {
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url)
        const now = this.now()
        if (url.pathname === '/put') {
          const body = (await request.json()) as { blob: string }
          const cur = this.records.get(iid)
          if (cur !== undefined && cur.expiresAt > now) return new Response(null, { status: 404 })
          const expiresAt = now + C.INVITE_TTL_MS
          this.records.set(iid, { blob: body.blob, expiresAt })
          return new Response(JSON.stringify({ expiresAt }), { status: 201 })
        }
        const rec = this.records.get(iid)
        this.records.delete(iid)
        if (rec === undefined || rec.expiresAt <= now) return new Response(null, { status: 404 })
        return new Response(JSON.stringify({ blob: rec.blob }), { status: 200 })
      },
    }
  }
}

// ── сборка сервисов ─────────────────────────────────────────────────────────

export interface Harness {
  svc: Services
  catalog: MemoryCatalog
  blobs: MemoryBlobs
  docs: TestDocs
  invites: TestInvites
  limiter: LocalLimiter
  flags: Flags
  /** Дождаться всего, что ушло в waitUntil (списание промахов, прогрев кэша). */
  settle(): Promise<void>
  clock: { now: number }
}

export function makeHarness(opts: { realClock?: boolean } = {}): Harness {
  const clock = { now: 1_800_000_000_000 }
  const now = (): number => (opts.realClock === true ? Date.now() : clock.now)
  const catalog = new MemoryCatalog()
  const blobs = new MemoryBlobs(now)
  const docs = new TestDocs(catalog, blobs, now)
  const invites = new TestInvites(now)
  const limiter = new LocalLimiter(now)
  const flags: Flags = { ...DEFAULT_FLAGS }
  const tasks: Array<Promise<unknown>> = []

  const svc: Services = {
    now,
    catalog,
    exists: new MemoryExists(now),
    penalty: new MemoryPenalty(),
    limiter,
    docs,
    invites,
    flags: { read: async (): Promise<Flags> => flags },
    turnstile: new DisabledTurnstile(),
    pepper: 'test-pepper',
    allowedOrigin: ALLOWED_ORIGIN,
    waitUntil: (p) => {
      tasks.push(p.catch(() => undefined))
    },
  }

  return {
    svc,
    catalog,
    blobs,
    docs,
    invites,
    limiter,
    flags,
    clock,
    settle: async (): Promise<void> => {
      while (tasks.length > 0) await tasks.shift()
    },
  }
}

// ── подпись ─────────────────────────────────────────────────────────────────

export interface Signer {
  alg: SigAlg
  pub: Uint8Array
  pubB32: string
  sign(data: Uint8Array): Promise<Uint8Array>
}

export async function makeSigner(alg: SigAlg = 'ed25519'): Promise<Signer> {
  const params: SubtleCryptoGenerateKeyAlgorithm =
    alg === 'ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }
  const pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair
  const exported = await crypto.subtle.exportKey('raw', pair.publicKey)
  const raw = new Uint8Array(exported as ArrayBuffer)
  const algo: SubtleCryptoSignAlgorithm =
    alg === 'ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' }
  return {
    alg,
    pub: raw,
    pubB32: encodeB32(raw),
    sign: async (data: Uint8Array): Promise<Uint8Array> =>
      new Uint8Array(await crypto.subtle.sign(algo, pair.privateKey, data as BufferSource)),
  }
}

export interface SignOpts {
  method: string
  path: string
  docId: string
  body?: Uint8Array
  tsMs: number
  nonce?: Uint8Array
  /** Подписать другой путь/метод, чем поедет в запросе, — для теста подмены. */
  signPath?: string
  signMethod?: string
}

export async function sigHeader(signer: Signer, o: SignOpts): Promise<string> {
  const body = o.body ?? new Uint8Array(0)
  const nonce = o.nonce ?? randomBytes(C.SIG_NONCE_BYTES)
  const canon = canonicalSigInput({
    method: o.signMethod ?? o.method,
    path: o.signPath ?? o.path,
    docIdBytes: docIdBytes(o.docId),
    tsMs: o.tsMs,
    sigNonce: nonce,
    bodySha256: await sha256(body),
  })
  const sig = await signer.sign(canon)
  return formatSigHeader({
    alg: signer.alg,
    tsMs: o.tsMs,
    sigNonceB32: encodeB32(nonce),
    sigB32: encodeB32(sig),
  })
}

export async function signedRequest(signer: Signer, o: SignOpts): Promise<Request> {
  const headers = new Headers({ 'x-elm-sig': await sigHeader(signer, o) })
  const init: RequestInit = { method: o.method, headers }
  if (o.body !== undefined && o.method !== 'GET' && o.method !== 'DELETE') {
    init.body = o.body as unknown as BodyInit
  }
  return new Request(HOST + o.path, init)
}

// ── фикстуры ────────────────────────────────────────────────────────────────

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  // getRandomValues отдаёт максимум 64 KiB за вызов — крупные блобы набираем кусками
  for (let o = 0; o < n; o += 65_536) {
    crypto.getRandomValues(b.subarray(o, Math.min(o + 65_536, n)))
  }
  return b
}

export function randomDocId(): DocId {
  return encodeB32(randomBytes(C.DOC_ID_BYTES)).slice(0, C.DOC_ID_CHARS) as DocId
}

export function docIdBytes(docId: string): Uint8Array {
  const out = new Uint8Array(C.DOC_ID_BYTES)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of docId) {
    acc = (acc << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
      acc &= (1 << bits) - 1
    }
  }
  return out
}

export function makeWrap(wrapVer = 1): WrapRecord {
  return {
    v: 1,
    wrapVer,
    kdf: { alg: 'none' },
    nonce: encodeB32(randomBytes(C.NONCE_BYTES)),
    ct: encodeB32(randomBytes(48)),
  }
}

/** EL1-пакет: "EL1" ‖ type ‖ nonce(12) ‖ шифротекст. Сервер его не разбирает. */
export function el1Payload(body: Uint8Array, type = 0x01): Uint8Array {
  const out = new Uint8Array(C.HEADER_BYTES + body.length)
  out[0] = 0x45
  out[1] = 0x4c
  out[2] = 0x31
  out[3] = type
  out.set(randomBytes(C.NONCE_BYTES), 4)
  out.set(body, C.HEADER_BYTES)
  return out
}

export function framePacket(
  clientId: Uint8Array,
  from: number,
  payloads: readonly Uint8Array[],
): Uint8Array {
  const frames: Frame[] = payloads.map((p, i) => ({
    seq: 0,
    clientId,
    clientSeq: from + i,
    ts: 0,
    payload: p,
  }))
  return encodeFrames(frames, { direction: 'c2s' })
}

/** Создать документ через полный конвейер Worker'а. */
export async function createDoc(
  h: Harness,
  signer: Signer,
  docId: DocId,
  extra: { snapshot?: Uint8Array; app?: number } = {},
): Promise<Response> {
  const { handleRequest } = await import('../../src/http/pipeline.js')
  const bodyObj: Record<string, unknown> = {
    docId,
    sigAlg: signer.alg,
    sigPub: signer.pubB32,
    app: extra.app ?? 1,
    wrap: makeWrap(1),
  }
  if (extra.snapshot !== undefined) bodyObj['snapshot'] = encodeB32(extra.snapshot)
  const body = new TextEncoder().encode(JSON.stringify(bodyObj))
  const req = await signedRequest(signer, {
    method: 'POST',
    path: PATHS.docs,
    docId,
    body,
    tsMs: h.svc.now(),
  })
  const res = await handleRequest(req, h.svc)
  await h.settle()
  return res
}

export { DOC_ID_HEADER }
