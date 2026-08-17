/**
 * Crockford base32 без паддинга. Алфавит и проверки формата — из @elementar/proto,
 * здесь только сам кодек (в proto его нет, а сервер обязан читать b32-поля запросов).
 */
import { CROCKFORD_ALPHABET, isCrockford } from '@elementar/proto'

const DECODE = new Int8Array(128).fill(-1)
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  DECODE[CROCKFORD_ALPHABET.charCodeAt(i)] = i
}

export function encodeB32(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31]
      acc &= (1 << bits) - 1
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31]
  return out
}

/** Строгий разбор: только канонические символы (uppercase, без дефисов), иначе null. */
export function decodeB32(s: string): Uint8Array | null {
  if (!isCrockford(s)) return null
  const out = new Uint8Array(Math.floor((s.length * 5) / 8))
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < s.length; i++) {
    const v = DECODE[s.charCodeAt(i)]
    if (v === undefined || v < 0) return null
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
      acc &= (1 << bits) - 1
    }
  }
  return out
}

/** То же, но с обязательной длиной результата: чужой ввод не должен «почти подойти». */
export function decodeB32Exact(s: string, expectBytes: number): Uint8Array | null {
  if (s.length !== Math.ceil((expectBytes * 8) / 5)) return null
  const b = decodeB32(s)
  return b !== null && b.length === expectBytes ? b : null
}
