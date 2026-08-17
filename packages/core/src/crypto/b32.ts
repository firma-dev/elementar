/**
 * Crockford base32 (§4.2): регистронезависимо, без I L O U, дефисы и пробелы игнорируются.
 * Кодирование — uppercase, без паддинга, MSB первым.
 */
import { CROCKFORD_ALPHABET, b32CharLen, normalizeB32Input } from '@elementar/proto'

export type Base32ErrorReason =
  'InvalidCharacter' | 'InvalidLength' | 'NonCanonicalEncoding' | 'UnexpectedLength'

export class Base32Error extends Error {
  override readonly name = 'Base32Error'
  readonly reason: Base32ErrorReason

  constructor(reason: Base32ErrorReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

const DECODE_MAP: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) m[CROCKFORD_ALPHABET[i] as string] = i
  return m
})()

export function b32encode(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31] as string
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31] as string
  return out
}

/**
 * Регистронезависимо; I,i,l,L → 1; O,o → 0; дефисы и пробелы отбрасываются;
 * U/u и любой посторонний символ → InvalidCharacter;
 * ненулевой хвостовой bit-паддинг → NonCanonicalEncoding.
 */
export function b32decode(s: string): Uint8Array {
  const norm = normalizeB32Input(s)
  if (norm === null) throw new Base32Error('InvalidCharacter', 'not a Crockford base32 string')

  const leftover = (norm.length * 5) % 8
  // 5 и больше «лишних» бит означают символ, не дающий ни одного полного байта
  if (leftover >= 5) throw new Base32Error('InvalidLength', `bad base32 length: ${norm.length}`)

  const out = new Uint8Array((norm.length * 5 - leftover) / 8)
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of norm) {
    const v = DECODE_MAP[ch]
    if (v === undefined) throw new Base32Error('InvalidCharacter', `bad character: ${ch}`)
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Base32Error('NonCanonicalEncoding', 'non-zero trailing bits')
  }
  return out
}

/** Тот же разбор, но без исключений: любая ошибка → null. */
export function tryB32decode(s: string): Uint8Array | null {
  try {
    return b32decode(s)
  } catch {
    return null
  }
}

/** Разбор с обязательной длиной результата (docId, nonce, ключи). */
export function b32decodeExact(s: string, byteLength: number): Uint8Array {
  const bytes = b32decode(s)
  if (bytes.length !== byteLength) {
    throw new Base32Error('UnexpectedLength', `expected ${byteLength} bytes, got ${bytes.length}`)
  }
  if (s.replace(/[-\s]/g, '').length !== b32CharLen(byteLength)) {
    throw new Base32Error('UnexpectedLength', 'unexpected character count')
  }
  return bytes
}

/** Разбор с обязательной длиной без исключений. */
export function tryB32decodeExact(s: string, byteLength: number): Uint8Array | null {
  try {
    return b32decodeExact(s, byteLength)
  } catch {
    return null
  }
}
