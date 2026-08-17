/**
 * Канонизация подписываемой строки (§4.5). Один и тот же код на клиенте и на сервере:
 * расхождение в один байт = все подписи невалидны.
 *
 * sigInput — бинарная конкатенация, все длины big-endian:
 *   "EL1W"(4) ‖ ver(1) ‖ u8(len METHOD) ‖ METHOD ‖ u16be(len path) ‖ path
 *   ‖ docIdBytes(12) ‖ u64be(unixMillis) ‖ sigNonce(12) ‖ sha256(body)(32)
 *
 * Метод и путь входят в подпись обязательно: без них подпись пустого тела для
 * WS-хендшейка переигрывалась как `DELETE /d/:docId` в пределах окна 120 с.
 */
import { C } from './consts.js'
import { PROTOCOL_VERSION, b32CharLen, isCrockford, isSigAlg } from './keys.js'
import type { SigAlg } from './keys.js'

/** Префикс домена подписи: "EL1W" (write/authorize). */
export const SIG_DOMAIN = 'EL1W'
const SIG_DOMAIN_BYTES = new Uint8Array([0x45, 0x4c, 0x31, 0x57]) // 'E','L','1','W'

/** Имя заголовка подписи (§4.5). Сравнивать в нижнем регистре. */
export const SIG_HEADER = 'x-elm-sig'

export type SigMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
export const SIG_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const satisfies readonly SigMethod[]

export function isSigMethod(v: string): v is SigMethod {
  return v === 'GET' || v === 'POST' || v === 'PUT' || v === 'DELETE'
}

export interface CanonArgs {
  /** 'GET' | 'POST' | 'PUT' | 'DELETE'; регистр нормализуется вверх. */
  method: string
  /** Путь без query, например '/v1/docs/K7M4.../deltas'. */
  path: string
  docIdBytes: Uint8Array
  tsMs: number
  /** 12 байт CSPRNG на запрос. */
  sigNonce: Uint8Array
  /** sha256 тела; для пустого тела — sha256 пустой строки. */
  bodySha256: Uint8Array
}

/** Ошибка канонизации: вход не удовлетворяет формату. Наружу в HTTP не выходит. */
export class CanonError extends Error {
  override readonly name = 'CanonError'
}

const MAX_PATH_BYTES = 0xffff
const SHA256_BYTES = 32
const MAX_U64_SAFE = Number.MAX_SAFE_INTEGER

const utf8 = new TextEncoder()

function checkPath(path: string): Uint8Array {
  if (path.length === 0 || path.charCodeAt(0) !== 0x2f) {
    throw new CanonError('path must start with "/"')
  }
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    // только печатный ASCII: путь из URL всегда percent-encoded, а любая вольность
    // в кодировании даёт разные байты у клиента и сервера
    if (c < 0x21 || c > 0x7e) throw new CanonError('path must be printable ASCII')
    if (c === 0x3f || c === 0x23) throw new CanonError('path must not contain query or fragment')
  }
  const bytes = utf8.encode(path)
  if (bytes.length > MAX_PATH_BYTES) throw new CanonError('path too long')
  return bytes
}

/**
 * Собирает канонический вход подписи. Байты идентичны на обеих сторонах —
 * это единственная функция, которой разрешено знать раскладку.
 */
export function canonicalSigInput(a: CanonArgs): Uint8Array {
  const method = a.method.toUpperCase()
  if (!isSigMethod(method)) throw new CanonError(`unsupported method: ${a.method}`)
  const methodBytes = utf8.encode(method)
  const pathBytes = checkPath(a.path)

  if (a.docIdBytes.length !== C.DOC_ID_BYTES) throw new CanonError('docIdBytes must be 12 bytes')
  if (a.sigNonce.length !== C.SIG_NONCE_BYTES) throw new CanonError('sigNonce must be 12 bytes')
  if (a.bodySha256.length !== SHA256_BYTES) throw new CanonError('bodySha256 must be 32 bytes')
  if (!Number.isInteger(a.tsMs) || a.tsMs < 0 || a.tsMs > MAX_U64_SAFE) {
    throw new CanonError('tsMs must be a non-negative safe integer')
  }

  const total =
    4 + // "EL1W"
    1 + // ver
    1 +
    methodBytes.length +
    2 +
    pathBytes.length +
    C.DOC_ID_BYTES +
    8 +
    C.SIG_NONCE_BYTES +
    SHA256_BYTES

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let o = 0
  out.set(SIG_DOMAIN_BYTES, o)
  o += 4
  out[o++] = PROTOCOL_VERSION
  out[o++] = methodBytes.length
  out.set(methodBytes, o)
  o += methodBytes.length
  view.setUint16(o, pathBytes.length, false)
  o += 2
  out.set(pathBytes, o)
  o += pathBytes.length
  out.set(a.docIdBytes, o)
  o += C.DOC_ID_BYTES
  view.setBigUint64(o, BigInt(a.tsMs), false)
  o += 8
  out.set(a.sigNonce, o)
  o += C.SIG_NONCE_BYTES
  out.set(a.bodySha256, o)
  return out
}

/** То же, но без исключений: для путей, пришедших снаружи. */
export function safeCanonicalSigInput(a: CanonArgs): Uint8Array | null {
  try {
    return canonicalSigInput(a)
  } catch (e) {
    if (e instanceof CanonError) return null
    throw e
  }
}

/** Разобранный `X-Elm-Sig: v1,<alg>,<tsMs>,<sigNonce b32>,<signature b32>`. */
export interface ParsedSigHeader {
  alg: SigAlg
  tsMs: number
  /** base32, 12 байт → 20 символов. */
  sigNonceB32: string
  /** base32 подписи; длина проверяется при декодировании в core. */
  sigB32: string
}

export function formatSigHeader(p: ParsedSigHeader): string {
  return `v1,${p.alg},${p.tsMs},${p.sigNonceB32},${p.sigB32}`
}

/** Разбор заголовка подписи. Ничего не бросает: любой мусор → null. */
export function parseSigHeader(raw: string | null | undefined): ParsedSigHeader | null {
  if (typeof raw !== 'string') return null
  const parts = raw.split(',')
  if (parts.length !== 5) return null
  const [ver, alg, ts, nonce, sig] = parts
  if (ver !== 'v1') return null
  if (alg === undefined || !isSigAlg(alg)) return null
  if (ts === undefined || !/^[0-9]{1,15}$/.test(ts)) return null
  const tsMs = Number(ts)
  if (!Number.isSafeInteger(tsMs)) return null
  if (nonce === undefined || nonce.length !== b32CharLen(C.SIG_NONCE_BYTES) || !isCrockford(nonce)) {
    return null
  }
  if (sig === undefined || sig.length === 0 || !isCrockford(sig)) return null
  return { alg, tsMs, sigNonceB32: nonce, sigB32: sig }
}

/** Часы разъехались больше, чем на SIG_SKEW_MS → 401 ELM_SIG_EXPIRED (§4.5). */
export function isTimestampFresh(tsMs: number, nowMs: number): boolean {
  return Math.abs(nowMs - tsMs) <= C.SIG_SKEW_MS
}
