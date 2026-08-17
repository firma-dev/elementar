/**
 * Имена HKDF-info, размеры, форматы docId и фрагмента (§4.1–4.4).
 * Только константы, типы и проверки формата строк — криптографические операции в core.
 */
import { C } from './consts.js'

export const PROTOCOL_VERSION = 1 as const
export const MAGIC = 'EL1' as const
/** 32 символа, без I L O U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const SIZES = {
  DOC_ID_BYTES: C.DOC_ID_BYTES,
  DOC_ID_CHARS: C.DOC_ID_CHARS,
  LINK_SECRET_BYTES: C.LINK_SECRET_BYTES,
  FRAGMENT_BYTES: C.FRAGMENT_BYTES,
  FRAGMENT_CHARS: C.FRAGMENT_CHARS,
  NONCE_BYTES: C.NONCE_BYTES,
  SESSION_TAG_BYTES: C.SESSION_TAG_BYTES,
  GCM_TAG_BYTES: C.GCM_TAG_BYTES,
  HEADER_BYTES: C.HEADER_BYTES,
  AAD_BYTES: C.AAD_BYTES,
  KDF_SALT_BYTES: C.KDF_SALT_BYTES,
  SIG_NONCE_BYTES: C.SIG_NONCE_BYTES,
  CHAIN_HASH_BYTES: C.CHAIN_HASH_BYTES,
} as const

export const INFO = {
  WRITE_KEY: 'elementar/1/write-key',
  KEK: 'elementar/1/kek',
  INVITE: 'elementar/1/invite',
} as const

/** 20 символов Crockford base32 (uppercase). */
export type DocId = string & { readonly __brand: 'DocId' }

/** Строка в Crockford base32 (uppercase, без паддинга). */
export type B32 = string

export type SigAlg = 'ed25519' | 'p256'
export const SIG_ALGS = ['ed25519', 'p256'] as const satisfies readonly SigAlg[]

export function isSigAlg(v: unknown): v is SigAlg {
  return v === 'ed25519' || v === 'p256'
}

/** Размер сырого публичного ключа подписи: raw 32 (ed25519) | raw 65 uncompressed (p256). */
export const SIG_PUB_BYTES: Readonly<Record<SigAlg, number>> = { ed25519: 32, p256: 65 }

/** Типы EL1-пакетов (§4.4). */
export const PacketType = {
  OpBatch: 0x01, // батч CRDT-операций
  Snapshot: 0x02, // полный слепок состояния
  KeyWrap: 0x03, // обёртка K_doc (шифруется на KEK, не на K_doc)
  DocMeta: 0x04, // заголовок/цвет документа + wrapVer (§5.5)
  Presence: 0x05, // эфемерное присутствие (§6.14)
  Forward: 0x06, // указатель на новый документ после ротации
} as const
export type PacketType = (typeof PacketType)[keyof typeof PacketType]

const PACKET_TYPE_VALUES: readonly number[] = Object.values(PacketType)

export function isPacketType(v: number): v is PacketType {
  return PACKET_TYPE_VALUES.includes(v)
}

/** Версия фрагмента: [ver:1 = 0x01][K_link:32] → 33 байта → 53 символа base32. */
export const FRAGMENT_VERSION = 0x01

/** Строгая проверка канонической формы (uppercase, без дефисов). */
const DOC_ID_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/
const FRAGMENT_RE = /^[0-9A-HJKMNP-TV-Z]{53}$/
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]*$/

export function isDocId(s: string): s is DocId {
  return DOC_ID_RE.test(s)
}

export function asDocId(s: string): DocId | null {
  return isDocId(s) ? s : null
}

export function isFragment(s: string): boolean {
  return FRAGMENT_RE.test(s)
}

/** Любой отображаемый или вводимый идентификатор проходит этот фильтр (§4.2). */
export function isCrockford(s: string): boolean {
  return CROCKFORD_RE.test(s)
}

/**
 * Нормализация ввода человеком: регистронезависимо, I/i/l/L → 1, O/o → 0,
 * дефисы и пробелы отбрасываются. U/u и любой другой посторонний символ → null.
 */
export function normalizeB32Input(s: string): string | null {
  let out = ''
  for (const raw of s) {
    if (raw === '-' || raw === ' ' || raw === '\t' || raw === '\n' || raw === '\r') continue
    const ch = raw.toUpperCase()
    if (ch === 'I' || ch === 'L') out += '1'
    else if (ch === 'O') out += '0'
    else if (CROCKFORD_ALPHABET.includes(ch)) out += ch
    else return null
  }
  return out
}

/** Сколько символов base32 (без паддинга) занимают n байт. */
export function b32CharLen(bytes: number): number {
  return Math.ceil((bytes * 8) / 5)
}

/** Отображение в UI — группами по 5 (`K7M4Q-8XB2N-…`), в URL слитно (§4.2). */
export function groupForDisplay(s: string, size = 5): string {
  const parts: string[] = []
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size))
  return parts.join('-')
}

/**
 * Префикс PKCS#8 для импорта Ed25519-seed в WebCrypto; далее идут 32 байта seed (§4.5).
 */
export const PKCS8_ED25519_PREFIX: Readonly<Uint8Array> = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])
