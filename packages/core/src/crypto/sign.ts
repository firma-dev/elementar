/**
 * Подпись запросов (§4.5). Одна подпись на всё, включая чтение: readToken не существует.
 * Канонизация — только через @elementar/proto (canonicalSigInput), здесь она не дублируется.
 *
 * Ed25519 — @noble/curves (в WebCrypto он есть не везде, особенно во встроенных браузерах
 * мессенджеров, куда ссылка и приезжает по QR). ECDSA P-256 — WebCrypto, обязательный
 * фолбэк; алгоритм фиксируется в sig_alg документа при создании и не меняется.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { sha256 as sha256sync } from '@noble/hashes/sha2.js'
import {
  C,
  PATHS,
  SIG_PUB_BYTES,
  canonicalSigInput,
  formatSigHeader,
  isTimestampFresh,
  parseSigHeader,
  formatWsSubprotocols,
} from '@elementar/proto'
import type { SigAlg, SigMethod, WsHandshake } from '@elementar/proto'
import { b32decodeExact, b32encode } from './b32.js'
import { concatBytes, randomBytes, sha256 } from './keys.js'

export type SignErrorReason = 'bad-seed' | 'bad-alg' | 'bad-key' | 'bad-signature'

export class SignError extends Error {
  override readonly name = 'SignError'
  readonly reason: SignErrorReason

  constructor(reason: SignErrorReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

export interface Signer {
  readonly alg: SigAlg
  /** raw: 32 байта ed25519 | 65 байт uncompressed p256. */
  readonly publicKey: Uint8Array
  readonly publicKeyB32: string
  sign(message: Uint8Array): Promise<Uint8Array>
}

/**
 * Скаляр P-256 из 32-байтного signSeed. Попадание вне [1, n−1] невероятно (≈2^−32),
 * но обрабатывается детерминированно, а не исключением: перехеширование сида.
 */
function p256ScalarFromSeed(seed: Uint8Array): Uint8Array {
  let cand = seed
  for (let i = 0; i < 256; i++) {
    if (p256.utils.isValidSecretKey(cand)) return cand
    cand = sha256sync(concatBytes(cand, Uint8Array.of(i)))
  }
  throw new SignError('bad-seed', 'cannot derive a valid P-256 scalar')
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function importP256Private(scalar: Uint8Array, pub: Uint8Array): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: b64url(scalar),
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    ext: false,
    key_ops: ['sign'],
  }
  return globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/** Ключ подписи выводится из signSeed; сервер хранит sigPub, зафиксированный при создании (TOFU). */
export async function createSigner(signSeed: Uint8Array, alg: SigAlg): Promise<Signer> {
  if (signSeed.length !== 32) throw new SignError('bad-seed', 'signSeed must be 32 bytes')
  if (alg === 'ed25519') {
    const publicKey = ed25519.getPublicKey(signSeed)
    const secret = signSeed.slice()
    return {
      alg,
      publicKey,
      publicKeyB32: b32encode(publicKey),
      sign(message: Uint8Array): Promise<Uint8Array> {
        return Promise.resolve(ed25519.sign(message, secret))
      },
    }
  }
  if (alg === 'p256') {
    const scalar = p256ScalarFromSeed(signSeed)
    const publicKey = p256.getPublicKey(scalar, false)
    const key = await importP256Private(scalar, publicKey)
    return {
      alg,
      publicKey,
      publicKeyB32: b32encode(publicKey),
      async sign(message: Uint8Array): Promise<Uint8Array> {
        const sig = await globalThis.crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          key,
          message as BufferSource,
        )
        return new Uint8Array(sig)
      },
    }
  }
  throw new SignError('bad-alg', `unknown sig alg: ${String(alg)}`)
}

export async function verifySignature(
  alg: SigAlg,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== SIG_PUB_BYTES[alg]) return false
  if (alg === 'ed25519') {
    if (signature.length !== 64) return false
    try {
      return ed25519.verify(signature, message, publicKey)
    } catch {
      return false
    }
  }
  if (signature.length !== 64) return false
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      publicKey as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature as BufferSource,
      message as BufferSource,
    )
  } catch {
    return false
  }
}

/**
 * Алгоритм по умолчанию для нового документа. Ed25519 считается через @noble/curves,
 * поэтому доступен всегда; p256 остаётся выбором для документов, созданных с ним раньше.
 */
export function preferredSigAlg(): SigAlg {
  return 'ed25519'
}

const EMPTY = new Uint8Array(0)

export interface SignRequestArgs {
  method: SigMethod | string
  /** Путь без query, например '/v1/docs/K7M4.../deltas'. */
  path: string
  docIdBytes: Uint8Array
  /** Тело запроса; для GET/DELETE — пусто. */
  body?: Uint8Array | null
  /** Только для тестов и повторной подписи готового запроса. */
  tsMs?: number
  sigNonce?: Uint8Array
}

export interface SignedRequest {
  /** Значение заголовка X-Elm-Sig: 'v1,<alg>,<ts>,<nonce b32>,<sig b32>'. */
  header: string
  alg: SigAlg
  tsMs: number
  sigNonce: Uint8Array
  signature: Uint8Array
  bodySha256: Uint8Array
}

export async function signRequest(signer: Signer, args: SignRequestArgs): Promise<SignedRequest> {
  const body = args.body ?? EMPTY
  const bodySha256 = await sha256(body)
  const tsMs = args.tsMs ?? Date.now()
  const sigNonce = args.sigNonce ?? randomBytes(C.SIG_NONCE_BYTES)
  const input = canonicalSigInput({
    method: args.method,
    path: args.path,
    docIdBytes: args.docIdBytes,
    tsMs,
    sigNonce,
    bodySha256,
  })
  const signature = await signer.sign(input)
  const header = formatSigHeader({
    alg: signer.alg,
    tsMs,
    sigNonceB32: b32encode(sigNonce),
    sigB32: b32encode(signature),
  })
  return { header, alg: signer.alg, tsMs, sigNonce, signature, bodySha256 }
}

export type VerifyRequestResult =
  | { ok: true; alg: SigAlg; tsMs: number; sigNonce: Uint8Array }
  | { ok: false; code: 'ELM_SIG_MISSING' | 'ELM_SIG_EXPIRED' | 'ELM_SIG_INVALID' }

export interface VerifyRequestArgs {
  header: string | null | undefined
  method: SigMethod | string
  path: string
  docIdBytes: Uint8Array
  /** sha256 тела; вычисляется вызывающим (сервер считает его один раз). */
  bodySha256: Uint8Array
  sigAlg: SigAlg
  sigPub: Uint8Array
  nowMs?: number
}

/**
 * Проверка шагов 1, 3 и 4 из §4.5. Шаг 2 (персистентный антиреплей sigNonce)
 * живёт на сервере: здесь нет состояния.
 */
export async function verifyRequest(args: VerifyRequestArgs): Promise<VerifyRequestResult> {
  const parsed = parseSigHeader(args.header)
  if (parsed === null) return { ok: false, code: 'ELM_SIG_MISSING' }
  if (parsed.alg !== args.sigAlg) return { ok: false, code: 'ELM_SIG_INVALID' }
  const nowMs = args.nowMs ?? Date.now()
  if (!isTimestampFresh(parsed.tsMs, nowMs)) return { ok: false, code: 'ELM_SIG_EXPIRED' }

  let sigNonce: Uint8Array
  let signature: Uint8Array
  let input: Uint8Array
  try {
    sigNonce = b32decodeExact(parsed.sigNonceB32, C.SIG_NONCE_BYTES)
    signature = b32decodeExact(parsed.sigB32, 64)
    input = canonicalSigInput({
      method: args.method,
      path: args.path,
      docIdBytes: args.docIdBytes,
      tsMs: parsed.tsMs,
      sigNonce,
      bodySha256: args.bodySha256,
    })
  } catch {
    return { ok: false, code: 'ELM_SIG_INVALID' }
  }
  const ok = await verifySignature(args.sigAlg, args.sigPub, input, signature)
  return ok
    ? { ok: true, alg: args.sigAlg, tsMs: parsed.tsMs, sigNonce }
    : { ok: false, code: 'ELM_SIG_INVALID' }
}

export interface WsHandshakeArgs {
  docId: string
  docIdBytes: Uint8Array
  since: number
  /** 8 байт, уникален на пару (устройство, документ) — §4.7.1 п.14. */
  clientId: Uint8Array
  tsMs?: number
  sigNonce?: Uint8Array
}

/** Подпись WS-хендшейка: GET + '/v1/docs/{docId}/ws' + пустое тело (§8.7). */
export async function signWsHandshake(signer: Signer, args: WsHandshakeArgs): Promise<WsHandshake> {
  if (args.clientId.length !== 8) throw new SignError('bad-key', 'clientId must be 8 bytes')
  const signed = await signRequest(signer, {
    method: 'GET',
    path: PATHS.ws(args.docId),
    docIdBytes: args.docIdBytes,
    body: null,
    ...(args.tsMs === undefined ? {} : { tsMs: args.tsMs }),
    ...(args.sigNonce === undefined ? {} : { sigNonce: args.sigNonce }),
  })
  return {
    since: args.since,
    clientIdB32: b32encode(args.clientId),
    sig: {
      alg: signer.alg,
      tsMs: signed.tsMs,
      sigNonceB32: b32encode(signed.sigNonce),
      sigB32: b32encode(signed.signature),
    },
  }
}

/** Готовые значения Sec-WebSocket-Protocol для этого хендшейка. */
export function wsSubprotocols(h: WsHandshake): string[] {
  return formatWsSubprotocols(h)
}
