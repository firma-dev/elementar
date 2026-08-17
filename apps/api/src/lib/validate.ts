/**
 * Разбор тел запросов. Сервер слеп, но формат обязан проверять: всё, что не подошло
 * под схему, — 400, а не «попробуем догадаться».
 */
import { C, KDF_LIMITS, SIG_PUB_BYTES, asDocId, isCrockford, isSigAlg } from '@elementar/proto'
import type {
  CreateDocRequest,
  CreateInviteRequest,
  DocId,
  KdfParams,
  WrapRecord,
} from '@elementar/proto'
import { decodeB32, decodeB32Exact } from './b32.js'

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export function parseKdf(v: unknown): KdfParams | null {
  if (!isRec(v)) return null
  const alg = v['alg']
  if (typeof alg !== 'string' || !(KDF_LIMITS.algAllow as readonly string[]).includes(alg))
    return null
  if (alg === 'none') return { alg: 'none' }
  const salt = v['salt']
  if (typeof salt !== 'string' || decodeB32Exact(salt, C.KDF_SALT_BYTES) === null) return null
  if (alg === 'argon2id') {
    const { mMin, mMax, tMin, tMax, pMin, pMax } = KDF_LIMITS.argon2id
    const m = v['m']
    const t = v['t']
    const p = v['p']
    if (!isInt(m, mMin, mMax) || !isInt(t, tMin, tMax) || !isInt(p, pMin, pMax)) return null
    return { alg: 'argon2id', m, t, p, salt }
  }
  const i = v['i']
  if (!isInt(i, KDF_LIMITS.pbkdf2.iMin, KDF_LIMITS.pbkdf2.iMax)) return null
  return { alg: 'pbkdf2-sha256', i, salt }
}

/** ct = K_doc(32) + tag(16) = 48 байт, nonce = 12 байт (§5.5). */
const WRAP_CT_BYTES = 48

export function parseWrap(v: unknown): WrapRecord | null {
  if (!isRec(v)) return null
  if (v['v'] !== 1) return null
  const wrapVer = v['wrapVer']
  if (!isInt(wrapVer, 1, Number.MAX_SAFE_INTEGER)) return null
  const kdf = parseKdf(v['kdf'])
  if (kdf === null) return null
  const nonce = v['nonce']
  const ct = v['ct']
  if (typeof nonce !== 'string' || decodeB32Exact(nonce, C.NONCE_BYTES) === null) return null
  if (typeof ct !== 'string' || decodeB32Exact(ct, WRAP_CT_BYTES) === null) return null
  return { v: 1, wrapVer, kdf, nonce, ct }
}

export interface ParsedCreate extends CreateDocRequest {
  sigPubBytes: Uint8Array
  snapshotBytes: Uint8Array | null
}

export function parseCreateDoc(v: unknown): ParsedCreate | null {
  if (!isRec(v)) return null
  const docIdRaw = v['docId']
  if (typeof docIdRaw !== 'string') return null
  const docId: DocId | null = asDocId(docIdRaw)
  if (docId === null) return null

  const sigAlg = v['sigAlg']
  if (!isSigAlg(sigAlg)) return null
  const sigPub = v['sigPub']
  if (typeof sigPub !== 'string') return null
  const sigPubBytes = decodeB32Exact(sigPub, SIG_PUB_BYTES[sigAlg])
  if (sigPubBytes === null) return null

  const wrap = parseWrap(v['wrap'])
  if (wrap === null) return null

  const appRaw = v['app']
  const app = appRaw === undefined ? 0 : isInt(appRaw, 0, 255) ? appRaw : null
  if (app === null) return null

  let snapshotBytes: Uint8Array | null = null
  const snap = v['snapshot']
  if (snap !== undefined) {
    if (typeof snap !== 'string' || !isCrockford(snap)) return null
    const bytes = decodeB32(snap)
    if (bytes === null || bytes.length > C.INLINE_SNAPSHOT_BYTES) return null
    snapshotBytes = bytes
  }

  const challenge = v['challenge']
  if (challenge !== undefined && typeof challenge !== 'string') return null

  const out: ParsedCreate = {
    docId,
    sigAlg,
    sigPub,
    app,
    wrap,
    sigPubBytes,
    snapshotBytes,
  }
  if (typeof snap === 'string') out.snapshot = snap
  if (typeof challenge === 'string') out.challenge = challenge
  return out
}

/** iid — 20 симв. b32, blob — ≤ 128 байт (§8.5). */
export const INVITE_BLOB_BYTES = 128

export interface ParsedInvite extends CreateInviteRequest {
  blobBytes: Uint8Array
}

export function parseInvite(v: unknown): ParsedInvite | null {
  if (!isRec(v)) return null
  const iid = v['iid']
  if (typeof iid !== 'string' || iid.length !== C.DOC_ID_CHARS || !isCrockford(iid)) return null
  const blob = v['blob']
  if (typeof blob !== 'string') return null
  const blobBytes = decodeB32(blob)
  if (blobBytes === null || blobBytes.length === 0 || blobBytes.length > INVITE_BLOB_BYTES)
    return null
  return { iid, blob, blobBytes }
}

/** since/limit из query у GET /deltas: только цифры, только в диапазоне (§9.3 «проверка чисел»). */
export function parseUint(
  raw: string | null,
  def: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return def
  if (!/^[0-9]{1,15}$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) return null
  return n
}
