/** Хеши и производные ключи. Всё через WebCrypto — в Worker'е других примитивов нет. */

const EMPTY = new Uint8Array(0)

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return new Uint8Array(d)
}

export function sha256Empty(): Promise<Uint8Array> {
  return sha256(EMPTY)
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', k, data as BufferSource)
  return new Uint8Array(sig)
}

/** HKDF-SHA256 → len байт. Используется для суточной ротации перца IP (§8.2). */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  len: number,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    k,
    len * 8,
  )
  return new Uint8Array(bits)
}

/** FNV-1a 32 бита — только для выбора шарда лимитера, не крипта. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(b.length)
  copy.set(b)
  return copy.buffer
}

export function fromSqlBlob(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  return new Uint8Array(0)
}
