/**
 * Постоянная ссылка, фрагмент, одноразовое приглашение и файл-ключ (§5.1–5.3, 5.6).
 *
 *   https://<origin>/p/<docId:20>#<fragment:53>
 *   fragment = [ver:1 = 0x01][K_link:32] → 33 байта → 53 символа base32
 *
 * docId и K_link — два независимых CSPRNG-значения (§4.3).
 */
import {
  APP_PREFIX,
  C,
  FRAGMENT_VERSION,
  INFO,
  ORIGIN,
  SIZES,
  isDocId,
  isFragment,
  normalizeB32Input,
} from '@elementar/proto'
import type { B32, DocId } from '@elementar/proto'
import { b32decodeExact, b32encode, tryB32decodeExact } from './b32.js'
import {
  concatBytes,
  docIdFromBytes,
  docIdToBytes,
  hkdfSha256,
  randomBytes,
  zeroize,
} from './keys.js'
import { importAesKey } from './envelope.js'
import {
  KDF_DEFAULTS,
  PasswordError,
  derivePasswordHash,
  newKdfParams,
  validateKdfParams,
} from './password.js'
import type { KdfParams } from '@elementar/proto'

export type LinkErrorReason =
  'bad-doc-id' | 'bad-fragment' | 'bad-url' | 'bad-invite' | 'bad-recovery'

export class LinkError extends Error {
  override readonly name = 'LinkError'
  readonly reason: LinkErrorReason

  constructor(reason: LinkErrorReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

export interface DocumentKeys {
  docId: DocId
  docIdBytes: Uint8Array
  linkSecret: Uint8Array
}

export interface ParsedLink {
  docId: DocId
  linkSecret: Uint8Array
  version: 1
}

/** Два независимых значения CSPRNG: 96 бит docId и 256 бит K_link. */
export function createDocumentKeys(): DocumentKeys {
  const docIdBytes = randomBytes(SIZES.DOC_ID_BYTES)
  const linkSecret = randomBytes(SIZES.LINK_SECRET_BYTES)
  return { docId: docIdFromBytes(docIdBytes), docIdBytes, linkSecret }
}

/** Восстановление пары ключей из уже известных docId и K_link. */
export function documentKeysFrom(docId: string, linkSecret: Uint8Array): DocumentKeys {
  if (linkSecret.length !== SIZES.LINK_SECRET_BYTES) {
    throw new LinkError('bad-fragment', 'linkSecret must be 32 bytes')
  }
  const docIdBytes = docIdToBytes(docId)
  return { docId: docIdFromBytes(docIdBytes), docIdBytes, linkSecret }
}

export function buildFragment(linkSecret: Uint8Array): string {
  if (linkSecret.length !== SIZES.LINK_SECRET_BYTES) {
    throw new LinkError('bad-fragment', 'linkSecret must be 32 bytes')
  }
  const raw = concatBytes(Uint8Array.of(FRAGMENT_VERSION), linkSecret)
  const s = b32encode(raw)
  zeroize(raw)
  return s
}

/** Разбор фрагмента: версия обязана быть 0x01, длина — ровно 53 символа. */
export function parseFragment(fragment: string): { version: 1; linkSecret: Uint8Array } {
  const norm = normalizeB32Input(fragment.startsWith('#') ? fragment.slice(1) : fragment)
  if (norm === null || !isFragment(norm)) {
    throw new LinkError('bad-fragment', 'fragment must be 53 base32 characters')
  }
  const raw = b32decodeExact(norm, SIZES.FRAGMENT_BYTES)
  if (raw[0] !== FRAGMENT_VERSION) {
    throw new LinkError('bad-fragment', `unknown fragment version: ${String(raw[0])}`)
  }
  return { version: 1, linkSecret: raw.slice(1) }
}

/** Постоянная ссылка. route — префикс двери: '/p' планер, '/f' финансер (§5.1). */
export function buildLink(
  origin: string,
  keys: DocumentKeys,
  route: string = APP_PREFIX.planer,
): string {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin
  const prefix = route.startsWith('/') ? route : `/${route}`
  return `${base}${prefix}/${keys.docId}#${buildFragment(keys.linkSecret)}`
}

/** Принимает полный URL или короткую форму '<docId>#<fragment>'. */
export function parseLink(input: string): ParsedLink {
  const raw = input.trim()
  const hash = raw.indexOf('#')
  if (hash < 0) throw new LinkError('bad-url', 'link has no fragment')
  const left = raw.slice(0, hash)
  const fragment = raw.slice(hash + 1)

  const lastSlash = left.lastIndexOf('/')
  const idPart = lastSlash >= 0 ? left.slice(lastSlash + 1) : left
  const normId = normalizeB32Input(idPart.split('?')[0] ?? '')
  if (normId === null || !isDocId(normId)) throw new LinkError('bad-doc-id', 'bad docId in link')

  const { linkSecret } = parseFragment(fragment)
  return { docId: normId, linkSecret, version: 1 }
}

/** Разбор без исключений: null вместо ошибки. */
export function tryParseLink(input: string): ParsedLink | null {
  try {
    return parseLink(input)
  } catch {
    return null
  }
}

export type LinkPersistState = 'unsaved' | 'saved'

/**
 * Разбирает location. Фрагмент НЕ стирается, пока persistState !== 'saved' (§5.2):
 * иначе ключ исчезает раньше, чем человек успевает его сохранить.
 */
export function consumeLinkFromLocation(loc?: Location, _hist?: History): ParsedLink | null {
  const l = loc ?? (typeof location === 'undefined' ? undefined : location)
  if (!l) return null
  const href = l.href
  if (typeof href !== 'string' || href.length === 0) return null
  return tryParseLink(href)
}

/**
 * После сохранения ссылки адресная строка приводится к виду /p/<docId>?d=1 —
 * закладка продолжает опознавать документ, но ключа в ней уже нет.
 */
export function sealAddressBar(docId: DocId, hist?: History, loc?: Location): void {
  const h = hist ?? (typeof history === 'undefined' ? undefined : history)
  if (!h || typeof h.replaceState !== 'function') return
  const l = loc ?? (typeof location === 'undefined' ? undefined : location)
  const path =
    l && typeof l.pathname === 'string' && l.pathname.endsWith(`/${docId}`)
      ? l.pathname
      : `${APP_PREFIX.planer}/${docId}`
  h.replaceState(null, '', `${path}?d=1`)
}

// ────────────────────────────── приглашение (§5.3) ──────────────────────────────

/** Маршрут одноразового приглашения: https://<origin>/i/<iid:20>#<inviteSecret:53>. */
export const INVITE_ROUTE = '/i'
const INVITE_KEK_INFO = 'elementar/1/invite-kek'
const INVITE_IID_BYTES = 12
/** K_link(32) ‖ docIdBytes(12) + tag(16). */
export const INVITE_BLOB_BYTES = SIZES.LINK_SECRET_BYTES + SIZES.DOC_ID_BYTES + SIZES.GCM_TAG_BYTES

export interface Invite {
  iid: string
  url: string
  expiresAt: number
}

export interface InviteMaterial extends Invite {
  /** I = CSPRNG(32); уходит только во фрагмент ссылки-приглашения. */
  secret: Uint8Array
  blob: Uint8Array
  blobB32: B32
}

async function inviteKeyAndNonce(
  secret: Uint8Array,
): Promise<{ key: Uint8Array; nonce: Uint8Array }> {
  // ключ и nonce выводятся из одного одноразового I: nonce хранить негде и незачем
  const bits = await hkdfSha256(secret, new Uint8Array(0), INVITE_KEK_INFO, 32 + SIZES.NONCE_BYTES)
  return { key: bits.slice(0, 32), nonce: bits.slice(32) }
}

export async function inviteIdFromSecret(secret: Uint8Array): Promise<string> {
  const raw = await hkdfSha256(secret, new Uint8Array(0), INFO.INVITE, INVITE_IID_BYTES)
  return b32encode(raw)
}

/**
 * Клиент: I = CSPRNG(32); iid = b32(HKDF(I, info='elementar/1/invite', 12));
 * blob = AES-GCM(HKDF(I, info='elementar/1/invite-kek'), K_link ‖ docIdBytes).
 * TTL 15 минут, одно использование, запись удаляется атомарно при первой отдаче.
 */
export async function createInviteMaterial(
  keys: DocumentKeys,
  ttlMs: number = C.INVITE_TTL_MS,
  origin: string = ORIGIN,
): Promise<InviteMaterial> {
  const secret = randomBytes(32)
  const iid = await inviteIdFromSecret(secret)
  const { key, nonce } = await inviteKeyAndNonce(secret)
  const payload = concatBytes(keys.linkSecret, keys.docIdBytes)
  try {
    const aes = await importAesKey(key)
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: SIZES.GCM_TAG_BYTES * 8 },
      aes,
      payload as BufferSource,
    )
    const blob = new Uint8Array(ct)
    const base = origin.endsWith('/') ? origin.slice(0, -1) : origin
    return {
      iid,
      secret,
      blob,
      blobB32: b32encode(blob),
      url: `${base}${INVITE_ROUTE}/${iid}#${buildFragment(secret)}`,
      expiresAt: Date.now() + ttlMs,
    }
  } finally {
    zeroize(payload, key)
  }
}

export interface ParsedInvite {
  iid: string
  secret: Uint8Array
}

/** Разбор ссылки-приглашения: полный URL или '<iid>#<fragment>'. */
export function parseInviteUrl(input: string): ParsedInvite | null {
  const raw = input.trim()
  const hash = raw.indexOf('#')
  if (hash < 0) return null
  const left = raw.slice(0, hash)
  const lastSlash = left.lastIndexOf('/')
  const idPart = lastSlash >= 0 ? left.slice(lastSlash + 1) : left
  const iid = normalizeB32Input(idPart.split('?')[0] ?? '')
  if (iid === null || iid.length !== SIZES.DOC_ID_CHARS) return null
  let secret: Uint8Array
  try {
    secret = parseFragment(raw.slice(hash + 1)).linkSecret
  } catch {
    return null
  }
  return { iid, secret }
}

/** Погашение: blob, полученный по GET /v1/invite/{iid}, разворачивается в ссылку. */
export async function openInviteBlob(
  secret: Uint8Array,
  blob: Uint8Array | B32,
): Promise<ParsedLink> {
  const bytes = typeof blob === 'string' ? tryB32decodeExact(blob, INVITE_BLOB_BYTES) : blob
  if (bytes === null || bytes.length !== INVITE_BLOB_BYTES) {
    throw new LinkError('bad-invite', 'malformed invite blob')
  }
  const { key, nonce } = await inviteKeyAndNonce(secret)
  try {
    const aes = await importAesKey(key)
    const pt = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: SIZES.GCM_TAG_BYTES * 8 },
        aes,
        bytes as BufferSource,
      ),
    )
    const linkSecret = pt.slice(0, SIZES.LINK_SECRET_BYTES)
    const docIdBytes = pt.slice(SIZES.LINK_SECRET_BYTES)
    return { docId: docIdFromBytes(docIdBytes), linkSecret, version: 1 }
  } catch (e) {
    if (e instanceof LinkError) throw e
    throw new LinkError('bad-invite', 'invite blob does not decrypt: expired or already burned')
  } finally {
    zeroize(key)
  }
}

// ────────────────────────────── файл-ключ (§5.6) ──────────────────────────────

const RECOVERY_INFO = 'elementar/1/recovery'
export const RECOVERY_MAGIC = 'elementar-recovery'

export type RecoveryProtect = { mode: 'passphrase'; passphrase: string } | { mode: 'plain' }

interface RecoveryPlain {
  elementar: typeof RECOVERY_MAGIC
  v: 1
  docId: string
  link: string
}

interface RecoverySealed {
  elementar: typeof RECOVERY_MAGIC
  v: 1
  docId: string
  route: string
  kdf: KdfParams
  nonce: B32
  ct: B32
}

async function recoveryKek(
  passphrase: string,
  kdf: KdfParams,
  docIdBytes: Uint8Array,
): Promise<Uint8Array> {
  const checked = validateKdfParams(kdf)
  if (checked.alg === 'none') throw new PasswordError('kdf-alg', 'recovery requires a real kdf')
  const hash = await derivePasswordHash(passphrase, checked)
  try {
    return await hkdfSha256(hash, docIdBytes, RECOVERY_INFO, 32)
  } finally {
    zeroize(hash)
  }
}

/**
 * Содержимое файла-ключа. По умолчанию ЗАШИФРОВАН парольной фразой: иначе файл с K_link
 * уезжает в облако вместе с папкой «Загрузки» открытым текстом.
 */
export async function exportRecovery(
  keys: DocumentKeys,
  opts: { protect: RecoveryProtect; route?: string; origin?: string },
): Promise<{ filename: string; body: string }> {
  const route = opts.route ?? APP_PREFIX.planer
  const origin = opts.origin ?? ORIGIN
  const filename = `elementar-${keys.docId}-recovery.txt`
  if (opts.protect.mode === 'plain') {
    const body: RecoveryPlain = {
      elementar: RECOVERY_MAGIC,
      v: 1,
      docId: keys.docId,
      link: buildLink(origin, keys, route),
    }
    return { filename, body: `${JSON.stringify(body, null, 2)}\n` }
  }
  const kdf = newKdfParams()
  const kek = await recoveryKek(opts.protect.passphrase, kdf, keys.docIdBytes)
  const nonce = randomBytes(SIZES.NONCE_BYTES)
  const fragment = concatBytes(Uint8Array.of(FRAGMENT_VERSION), keys.linkSecret)
  try {
    const aes = await importAesKey(kek)
    const ct = await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: keys.docIdBytes as BufferSource,
        tagLength: SIZES.GCM_TAG_BYTES * 8,
      },
      aes,
      fragment as BufferSource,
    )
    const body: RecoverySealed = {
      elementar: RECOVERY_MAGIC,
      v: 1,
      docId: keys.docId,
      route,
      kdf,
      nonce: b32encode(nonce),
      ct: b32encode(new Uint8Array(ct)),
    }
    return { filename, body: `${JSON.stringify(body, null, 2)}\n` }
  } finally {
    zeroize(kek, fragment)
  }
}

/** Обратная операция: содержимое файла-ключа → ссылка. */
export async function importRecovery(body: string, passphrase?: string): Promise<ParsedLink> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new LinkError('bad-recovery', 'recovery file is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new LinkError('bad-recovery', 'recovery file is malformed')
  }
  const r = parsed as Record<string, unknown>
  if (r['elementar'] !== RECOVERY_MAGIC || r['v'] !== 1 || typeof r['docId'] !== 'string') {
    throw new LinkError('bad-recovery', 'not an elementar recovery file')
  }
  if (typeof r['link'] === 'string') return parseLink(r['link'])

  if (typeof r['nonce'] !== 'string' || typeof r['ct'] !== 'string') {
    throw new LinkError('bad-recovery', 'recovery file has neither link nor ciphertext')
  }
  if (passphrase === undefined || passphrase.length === 0) {
    throw new LinkError('bad-recovery', 'recovery file is protected by a passphrase')
  }
  const docIdBytes = docIdToBytes(r['docId'])
  const nonce = tryB32decodeExact(r['nonce'], SIZES.NONCE_BYTES)
  const ct = tryB32decodeExact(r['ct'], SIZES.FRAGMENT_BYTES + SIZES.GCM_TAG_BYTES)
  if (nonce === null || ct === null) throw new LinkError('bad-recovery', 'malformed recovery blob')
  const kek = await recoveryKek(passphrase, r['kdf'] as KdfParams, docIdBytes)
  try {
    const aes = await importAesKey(kek)
    const pt = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce as BufferSource,
          additionalData: docIdBytes as BufferSource,
          tagLength: SIZES.GCM_TAG_BYTES * 8,
        },
        aes,
        ct as BufferSource,
      ),
    )
    if (pt.length !== SIZES.FRAGMENT_BYTES || pt[0] !== FRAGMENT_VERSION) {
      throw new LinkError('bad-recovery', 'unexpected recovery payload')
    }
    return { docId: docIdFromBytes(docIdBytes), linkSecret: pt.slice(1), version: 1 }
  } catch (e) {
    if (e instanceof LinkError) throw e
    throw new LinkError('bad-recovery', 'wrong passphrase or damaged recovery file')
  } finally {
    zeroize(kek)
  }
}

/** Размер соли KDF в файле-ключе — тот же, что у пароля документа. */
export const RECOVERY_SALT_BYTES = KDF_DEFAULTS.saltBytes
