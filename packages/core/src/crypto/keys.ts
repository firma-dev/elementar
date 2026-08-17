/**
 * Дерево ключей из K_link (§4.3). Все деривации — HKDF-SHA256, salt = docIdBytes.
 *
 *   signSeed = HKDF(K_link, salt=docIdBytes, info="elementar/1/write-key", 32)
 *   KEK0     = HKDF(K_link, salt=docIdBytes, info="elementar/1/kek", 32)
 *   KEK1     = HKDF(K_link ‖ argon2id(pw, pwSalt), salt=docIdBytes, info="elementar/1/kek", 32)
 *
 * docId НЕ выводится из K_link: иначе он становится офлайн-верификатором (§4.3).
 */
import { INFO, SIZES, asDocId } from '@elementar/proto'
import type { DocId } from '@elementar/proto'
import { b32decodeExact, b32encode } from './b32.js'

const utf8 = new TextEncoder()

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Затирает секреты в памяти. Гарантий от GC нет, но копию в живом буфере убирает. */
export function zeroize(...parts: readonly Uint8Array[]): void {
  for (const p of parts) p.fill(0)
}

/** Сравнение за постоянное время: длина утекает, содержимое — нет. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)
  return new Uint8Array(d)
}

/** HKDF-SHA256: extract+expand одним вызовом WebCrypto. */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string | Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (ikm.length === 0) throw new Error('hkdf: empty ikm')
  if (length <= 0 || length > 8160) throw new Error('hkdf: bad output length')
  const key = await globalThis.crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
    'deriveBits',
  ])
  const infoBytes = typeof info === 'string' ? utf8.encode(info) : info
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: infoBytes as BufferSource,
    },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

function checkDocIdBytes(docIdBytes: Uint8Array): void {
  if (docIdBytes.length !== SIZES.DOC_ID_BYTES) throw new Error('docIdBytes must be 12 bytes')
}

function checkLinkSecret(linkSecret: Uint8Array): void {
  if (linkSecret.length !== SIZES.LINK_SECRET_BYTES) throw new Error('linkSecret must be 32 bytes')
}

/** Ed25519/P-256 seed для подписи (§4.5). */
export async function deriveSignSeed(
  linkSecret: Uint8Array,
  docIdBytes: Uint8Array,
): Promise<Uint8Array> {
  checkLinkSecret(linkSecret)
  checkDocIdBytes(docIdBytes)
  return hkdfSha256(linkSecret, docIdBytes, INFO.WRITE_KEY, 32)
}

/** KEK без пароля. */
export async function deriveKek0(
  linkSecret: Uint8Array,
  docIdBytes: Uint8Array,
): Promise<Uint8Array> {
  checkLinkSecret(linkSecret)
  checkDocIdBytes(docIdBytes)
  return hkdfSha256(linkSecret, docIdBytes, INFO.KEK, 32)
}

/** KEK с паролем: ikm = K_link ‖ argon2id(pw, pwSalt) (или pbkdf2 — §5.4). */
export async function deriveKek1(
  linkSecret: Uint8Array,
  passwordHash: Uint8Array,
  docIdBytes: Uint8Array,
): Promise<Uint8Array> {
  checkLinkSecret(linkSecret)
  checkDocIdBytes(docIdBytes)
  if (passwordHash.length === 0) throw new Error('passwordHash must not be empty')
  const ikm = concatBytes(linkSecret, passwordHash)
  try {
    return await hkdfSha256(ikm, docIdBytes, INFO.KEK, 32)
  } finally {
    zeroize(ikm)
  }
}

/** K_doc всегда случайный и всегда хранится завёрнутым — даже без пароля (§4.3). */
export function generateDocKey(): Uint8Array {
  return randomBytes(32)
}

export function docIdFromBytes(bytes: Uint8Array): DocId {
  checkDocIdBytes(bytes)
  const s = asDocId(b32encode(bytes))
  if (s === null) throw new Error('docId encoding failed')
  return s
}

export function docIdToBytes(docId: string): Uint8Array {
  return b32decodeExact(docId, SIZES.DOC_ID_BYTES)
}

/** Шаг 2 открытия документа (§7.6): из ссылки — идентичность подписи и KEK0. */
export interface LinkIdentity {
  docId: DocId
  docIdBytes: Uint8Array
  linkSecret: Uint8Array
  /** 32 байта: seed ключа подписи. */
  signSeed: Uint8Array
  /** 32 байта: KEK беспарольного режима. */
  kek0: Uint8Array
}

export async function deriveLinkIdentity(
  docId: string,
  linkSecret: Uint8Array,
): Promise<LinkIdentity> {
  const docIdBytes = docIdToBytes(docId)
  const id = docIdFromBytes(docIdBytes)
  const [signSeed, kek0] = await Promise.all([
    deriveSignSeed(linkSecret, docIdBytes),
    deriveKek0(linkSecret, docIdBytes),
  ])
  return { docId: id, docIdBytes, linkSecret, signSeed, kek0 }
}
