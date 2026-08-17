/**
 * Конверт EL1 (§4.4) и паддинг по корзинам (§4.6).
 *
 *   байты  0..2  : "EL1"
 *   байт   3     : type
 *   байты  4..15 : nonce = sessionTag(8) ‖ counter(4, BE)
 *   байты 16..   : ciphertext ‖ tag(16)
 *
 * AAD = "EL1"(3) ‖ type(1) ‖ docIdBytes(12) — берётся из @elementar/proto (buildAadBytes):
 * запрет тихого даунгрейда версии, подмены типа и переноса блоба между документами.
 */
import {
  SIZES,
  buildAadBytes,
  decodeEnvelope,
  encodeEnvelope,
  isPacketType,
} from '@elementar/proto'
import type { PacketType } from '@elementar/proto'

export type EnvelopeErrorReason =
  | 'bad-key'
  | 'bad-nonce'
  | 'bad-doc-id'
  | 'bad-packet'
  | 'auth-failed'
  | 'bad-padding'
  | 'wrong-type'

export class EnvelopeError extends Error {
  override readonly name = 'EnvelopeError'
  readonly reason: EnvelopeErrorReason

  constructor(reason: EnvelopeErrorReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

/**
 * Корзины паддинга (§4.6): ISO/IEC 7816-4 (0x80, далее нули) ДО шифрования.
 * +1 байт под сам маркер.
 */
export function bucketSize(n: number): number {
  const m = n + 1
  if (m <= 4096) return Math.ceil(m / 256) * 256
  if (m <= 65536) return Math.ceil(m / 4096) * 4096
  return Math.ceil(m / 65536) * 65536
}

/** Выше этого размера паддинг не окупается — снапшоты > 1 MiB (§4.6). */
export const PAD_MAX_BYTES = 1_048_576

/** Первый байт открытого текста: был ли применён паддинг. Внутри шифротекста, наружу не виден. */
export const PAD_FLAG_OFF = 0x00
export const PAD_FLAG_ON = 0x01
const PAD_MARKER = 0x80

export type PadMode = 'auto' | 'on' | 'off'

function shouldPad(mode: PadMode, dataLength: number): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return dataLength <= PAD_MAX_BYTES
}

/**
 * Готовит открытый текст к шифрованию: флаг(1) ‖ data ‖ [0x80 ‖ нули до корзины].
 * Флаг нужен потому, что паддинг условный: без него получатель не отличит
 * настоящий хвост данных от маркера.
 */
export function padPlaintext(data: Uint8Array, mode: PadMode = 'auto'): Uint8Array {
  const inner = 1 + data.length
  if (!shouldPad(mode, data.length)) {
    const out = new Uint8Array(inner)
    out[0] = PAD_FLAG_OFF
    out.set(data, 1)
    return out
  }
  const out = new Uint8Array(bucketSize(inner))
  out[0] = PAD_FLAG_ON
  out.set(data, 1)
  out[inner] = PAD_MARKER
  return out
}

/** Обратная операция. Битый паддинг — ошибка, а не молчаливое усечение. */
export function unpadPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < 1) throw new EnvelopeError('bad-padding', 'empty plaintext')
  const flag = padded[0] as number
  if (flag === PAD_FLAG_OFF) return padded.slice(1)
  if (flag !== PAD_FLAG_ON) throw new EnvelopeError('bad-padding', 'unknown padding flag')
  let i = padded.length - 1
  while (i >= 1 && padded[i] === 0x00) i--
  if (i < 1 || padded[i] !== PAD_MARKER) {
    throw new EnvelopeError('bad-padding', 'ISO 7816-4 marker not found')
  }
  return padded.slice(1, i)
}

export type DocKeyInput = CryptoKey | Uint8Array

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new EnvelopeError('bad-key', 'AES-256 key must be 32 bytes')
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

async function resolveKey(key: DocKeyInput): Promise<CryptoKey> {
  return key instanceof Uint8Array ? importAesKey(key) : key
}

export interface SealArgs {
  key: DocKeyInput
  type: PacketType
  docIdBytes: Uint8Array
  /** 12 байт из NonceSource.next(). */
  nonce: Uint8Array
  plaintext: Uint8Array
  /** По умолчанию 'auto': паддинг включён, кроме payload > 1 MiB. */
  pad?: PadMode
}

/** Шифрует и собирает готовый EL1-пакет. */
export async function sealPacket(args: SealArgs): Promise<Uint8Array> {
  if (!isPacketType(args.type)) throw new EnvelopeError('bad-packet', 'unknown packet type')
  if (args.docIdBytes.length !== SIZES.DOC_ID_BYTES) {
    throw new EnvelopeError('bad-doc-id', 'docIdBytes must be 12 bytes')
  }
  if (args.nonce.length !== SIZES.NONCE_BYTES) {
    throw new EnvelopeError('bad-nonce', 'nonce must be 12 bytes')
  }
  const key = await resolveKey(args.key)
  const aad = buildAadBytes(args.type, args.docIdBytes)
  const padded = padPlaintext(args.plaintext, args.pad ?? 'auto')
  const ct = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: args.nonce as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: SIZES.GCM_TAG_BYTES * 8,
    },
    key,
    padded as BufferSource,
  )
  padded.fill(0)
  return encodeEnvelope({ type: args.type, nonce: args.nonce, body: new Uint8Array(ct) })
}

export interface OpenArgs {
  key: DocKeyInput
  docIdBytes: Uint8Array
  packet: Uint8Array
  /** Если задан — тип пакета обязан совпасть (иначе wrong-type ещё до расшифровки). */
  expectType?: PacketType
}

export interface OpenedPacket {
  type: PacketType
  nonce: Uint8Array
  plaintext: Uint8Array
}

/** Разбирает и расшифровывает EL1-пакет. Подмена AAD (тип, docId, версия) → auth-failed. */
export async function openPacket(args: OpenArgs): Promise<OpenedPacket> {
  if (args.docIdBytes.length !== SIZES.DOC_ID_BYTES) {
    throw new EnvelopeError('bad-doc-id', 'docIdBytes must be 12 bytes')
  }
  const env = decodeEnvelope(args.packet)
  if (env === null) throw new EnvelopeError('bad-packet', 'not an EL1 envelope')
  if (args.expectType !== undefined && env.type !== args.expectType) {
    throw new EnvelopeError('wrong-type', `expected type ${args.expectType}, got ${env.type}`)
  }
  const key = await resolveKey(args.key)
  const aad = buildAadBytes(env.type, args.docIdBytes)
  let padded: Uint8Array
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: env.nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: SIZES.GCM_TAG_BYTES * 8,
      },
      key,
      env.body as BufferSource,
    )
    padded = new Uint8Array(pt)
  } catch {
    throw new EnvelopeError('auth-failed', 'GCM authentication failed')
  }
  const plaintext = unpadPlaintext(padded)
  padded.fill(0)
  return { type: env.type, nonce: env.nonce, plaintext }
}

/** Тот же open, но без исключений: любая порча или чужой ключ → null. */
export async function tryOpenPacket(args: OpenArgs): Promise<OpenedPacket | null> {
  try {
    return await openPacket(args)
  } catch {
    return null
  }
}

/** Точный размер готового пакета для данного открытого текста (для лимитов §8). */
export function sealedSize(plaintextLength: number, pad: PadMode = 'auto'): number {
  const inner = 1 + plaintextLength
  const padded = shouldPad(pad, plaintextLength) ? bucketSize(inner) : inner
  return SIZES.HEADER_BYTES + padded + SIZES.GCM_TAG_BYTES
}
