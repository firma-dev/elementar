import { CROCKFORD_ALPHABET } from '@elementar/proto'

const ENC = /* @__PURE__ */ new TextEncoder()
const DEC = /* @__PURE__ */ new TextDecoder()

export function utf8(s: string): Uint8Array {
  return ENC.encode(s)
}

export function fromUtf8(b: Uint8Array): string {
  return DEC.decode(b)
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function toHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0')
  return s
}

/**
 * Crockford base32 без паддинга. Публичный кодек живёт в `crypto/b32.ts`;
 * здесь минимальная копия, чтобы модель документа не зависела от крипто-слоя.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | (bytes[i] as number)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31]
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31]
  return out
}

export function byteLengthOfUtf8(s: string): number {
  return ENC.encode(s).length
}
