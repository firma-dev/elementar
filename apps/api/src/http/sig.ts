/**
 * Проверка подписи (§4.5). Канонизация — общая функция из @elementar/proto: расхождение
 * в один байт означало бы, что ни одна честная подпись не проходит.
 *
 * Порядок проверок: свежесть ts → байты канона → криптопроверка → антиреплей по nonce.
 * Nonce отмечается ПОСЛЕ успешной криптопроверки: настоящий реплей несёт валидную подпись
 * и всё равно ловится, а мусорный трафик не раздувает таблицу sig_nonces.
 */
import { SIG_PUB_BYTES, isTimestampFresh, safeCanonicalSigInput } from '@elementar/proto'
import type { ElmErrorCode, SigAlg } from '@elementar/proto'
import { decodeB32, decodeB32Exact } from '../lib/b32.js'
import { C } from '@elementar/proto'

export const P256_SIG_BYTES = 64
export const ED25519_SIG_BYTES = 64

export interface SigCheck {
  method: string
  path: string
  docIdBytes: Uint8Array
  bodySha256: Uint8Array
  alg: SigAlg
  tsMs: number
  sigNonceB32: string
  sigB32: string
  sigPub: Uint8Array
  nowMs: number
}

export type SigVerdict = { ok: true; nonce: Uint8Array } | { ok: false; code: ElmErrorCode }

export async function verifySignature(i: SigCheck): Promise<SigVerdict> {
  if (!isTimestampFresh(i.tsMs, i.nowMs)) return { ok: false, code: 'ELM_SIG_EXPIRED' }

  const nonce = decodeB32Exact(i.sigNonceB32, C.SIG_NONCE_BYTES)
  if (nonce === null) return { ok: false, code: 'ELM_SIG_INVALID' }

  const sig = decodeB32(i.sigB32)
  if (sig === null || sig.length !== ED25519_SIG_BYTES)
    return { ok: false, code: 'ELM_SIG_INVALID' }
  if (i.sigPub.length !== SIG_PUB_BYTES[i.alg]) return { ok: false, code: 'ELM_SIG_INVALID' }

  const canon = safeCanonicalSigInput({
    method: i.method,
    path: i.path,
    docIdBytes: i.docIdBytes,
    tsMs: i.tsMs,
    sigNonce: nonce,
    bodySha256: i.bodySha256,
  })
  if (canon === null) return { ok: false, code: 'ELM_SIG_INVALID' }

  const ok = await verifyRaw(i.alg, i.sigPub, sig, canon)
  return ok ? { ok: true, nonce } : { ok: false, code: 'ELM_SIG_INVALID' }
}

async function verifyRaw(
  alg: SigAlg,
  pub: Uint8Array,
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    if (alg === 'ed25519') {
      const key = await crypto.subtle.importKey(
        'raw',
        pub as BufferSource,
        { name: 'Ed25519' },
        false,
        ['verify'],
      )
      return await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        sig as BufferSource,
        data as BufferSource,
      )
    }
    const key = await crypto.subtle.importKey(
      'raw',
      pub as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig as BufferSource,
      data as BufferSource,
    )
  } catch {
    // кривой ключ, кривая подпись, отсутствие алгоритма в рантайме — всё это «не прошло»
    return false
  }
}
