/**
 * Пароль как второй фактор поверх ссылки (§5.4) и wrap-record с защитой от отката (§5.5).
 *
 *   KEK0 = HKDF(K_link, salt=docIdBytes, info=INFO.KEK)                       — без пароля
 *   KEK1 = HKDF(K_link ‖ argon2id(pw, pwSalt), salt=docIdBytes, info=INFO.KEK) — с паролем
 *
 * Никакое публичное значение (docId, wrap.salt, ETag) не является функцией пароля —
 * иначе оно становится офлайн-верификатором.
 */
import { C, KDF_LIMITS, PacketType, SIZES, buildAadBytes } from '@elementar/proto'
import type { B32, KdfParams, WrapRecord } from '@elementar/proto'
import { b32decodeExact, b32encode, tryB32decodeExact } from './b32.js'
import { deriveKek0, deriveKek1, randomBytes, timingSafeEqual, zeroize } from './keys.js'
import { EnvelopeError, importAesKey } from './envelope.js'
import { PASSPHRASE_WORDLIST, PASSPHRASE_WORD_BITS } from './wordlist.js'

export { KDF_LIMITS }
export { PASSPHRASE_WORDLIST, PASSPHRASE_WORD_BITS }

export const KDF_DEFAULTS = {
  argon2id: { m: C.ARGON2_M_KIB, t: C.ARGON2_T, p: C.ARGON2_P, outLen: 32 },
  pbkdf2: { iterations: C.PBKDF2_ITERATIONS, hash: 'SHA-256' as const, outLen: 32 },
  saltBytes: C.KDF_SALT_BYTES,
  targetMs: C.KDF_TARGET_MS,
} as const

export type KdfAlg = KdfParams['alg']
export type PasswordKdfAlg = Exclude<KdfAlg, 'none'>
/** Параметры KDF с настоящим вычислением — всё, кроме alg: 'none'. */
export type PasswordKdfParams = Exclude<KdfParams, { alg: 'none' }>

export type PasswordErrorReason =
  | 'kdf-alg'
  | 'kdf-params'
  | 'kdf-salt'
  | 'password-required'
  | 'password-unexpected'
  | 'password-weak'
  | 'bad-wrap'
  | 'bad-password'

export class PasswordError extends Error {
  override readonly name = 'PasswordError'
  readonly reason: PasswordErrorReason

  constructor(reason: PasswordErrorReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

/** Громкая ошибка отката wrap-записи (§5.5 п.1–2), а не тихое принятие. */
export class WrapRollbackError extends Error {
  override readonly name = 'WrapRollback'
  readonly seenVer: number
  readonly incomingVer: number

  constructor(message: string, seenVer: number, incomingVer: number) {
    super(message)
    this.seenVer = seenVer
    this.incomingVer = incomingVer
  }
}

const utf8 = new TextEncoder()

/** NFKC; обрезаются только \n и \r от копипасты. */
export function normalizePassword(pw: string): string {
  return pw.replace(/[\r\n]+/g, '').normalize('NFKC')
}

function checkSalt(salt: B32): Uint8Array {
  const bytes = tryB32decodeExact(salt, KDF_DEFAULTS.saltBytes)
  if (bytes === null) throw new PasswordError('kdf-salt', 'kdf salt must be 16 bytes base32')
  return bytes
}

/**
 * Жёсткие клампы (§5.5 п.3): значения из wrap-записи, выходящие за границы, — ОШИБКА,
 * а не исполнение. Без этого сервер кладёт m = 4 GiB и вешает телефон партнёра.
 */
export function validateKdfParams(kdf: KdfParams): KdfParams {
  if (kdf === null || typeof kdf !== 'object') throw new PasswordError('kdf-params', 'kdf missing')
  if (!(KDF_LIMITS.algAllow as readonly string[]).includes(kdf.alg)) {
    throw new PasswordError('kdf-alg', `kdf alg not allowed: ${String(kdf.alg)}`)
  }
  if (kdf.alg === 'none') return kdf
  if (kdf.alg === 'argon2id') {
    const { m, t, p } = kdf
    const L = KDF_LIMITS.argon2id
    if (!Number.isInteger(m) || m < L.mMin || m > L.mMax) {
      throw new PasswordError('kdf-params', `argon2id m out of range: ${String(m)}`)
    }
    if (!Number.isInteger(t) || t < L.tMin || t > L.tMax) {
      throw new PasswordError('kdf-params', `argon2id t out of range: ${String(t)}`)
    }
    if (!Number.isInteger(p) || p < L.pMin || p > L.pMax) {
      throw new PasswordError('kdf-params', `argon2id p out of range: ${String(p)}`)
    }
    checkSalt(kdf.salt)
    return kdf
  }
  const L = KDF_LIMITS.pbkdf2
  if (!Number.isInteger(kdf.i) || kdf.i < L.iMin || kdf.i > L.iMax) {
    throw new PasswordError('kdf-params', `pbkdf2 i out of range: ${String(kdf.i)}`)
  }
  checkSalt(kdf.salt)
  return kdf
}

/** Argon2id доступен только при наличии WebAssembly; иначе честный откат на PBKDF2 (§5.4). */
export function preferredPasswordKdf(): PasswordKdfAlg {
  return typeof WebAssembly === 'undefined' ? 'pbkdf2-sha256' : 'argon2id'
}

/** Новые параметры KDF со свежей солью. */
export function newKdfParams(alg: PasswordKdfAlg = preferredPasswordKdf()): PasswordKdfParams {
  const salt = b32encode(randomBytes(KDF_DEFAULTS.saltBytes))
  if (alg === 'argon2id') {
    const d = KDF_DEFAULTS.argon2id
    return { alg: 'argon2id', m: d.m, t: d.t, p: d.p, salt }
  }
  return { alg: 'pbkdf2-sha256', i: KDF_DEFAULTS.pbkdf2.iterations, salt }
}

async function pbkdf2Bits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8.encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: KDF_DEFAULTS.pbkdf2.hash, salt: salt as BufferSource, iterations },
    key,
    KDF_DEFAULTS.pbkdf2.outLen * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Хеш пароля для ikm KEK1. Параметры обязательно проходят клампы ДО вычисления.
 * Argon2id грузится ленивым wasm-чанком здесь и только здесь.
 */
export async function derivePasswordHash(password: string, kdf: KdfParams): Promise<Uint8Array> {
  const checked = validateKdfParams(kdf)
  if (checked.alg === 'none') throw new PasswordError('password-unexpected', 'kdf alg is none')
  const salt = checkSalt(checked.salt)
  const pw = normalizePassword(password)
  if (pw.length === 0) throw new PasswordError('password-required', 'empty password')
  if (checked.alg === 'pbkdf2-sha256') return pbkdf2Bits(pw, salt, checked.i)
  const { argon2id } = await import('hash-wasm')
  return argon2id({
    password: pw,
    salt,
    parallelism: checked.p,
    memorySize: checked.m,
    iterations: checked.t,
    hashLength: KDF_DEFAULTS.argon2id.outLen,
    outputType: 'binary',
  })
}

export interface DeriveKekArgs {
  linkSecret: Uint8Array
  docIdBytes: Uint8Array
  kdf: KdfParams
  password?: string | null
}

/** KEK0 при alg='none', иначе KEK1. Лишний пароль и пропущенный пароль — обе ошибки. */
export async function deriveKek(args: DeriveKekArgs): Promise<Uint8Array> {
  const kdf = validateKdfParams(args.kdf)
  if (kdf.alg === 'none') {
    if (args.password) throw new PasswordError('password-unexpected', 'document has no password')
    return deriveKek0(args.linkSecret, args.docIdBytes)
  }
  if (!args.password) throw new PasswordError('password-required', 'document is password-protected')
  const hash = await derivePasswordHash(args.password, kdf)
  try {
    return await deriveKek1(args.linkSecret, hash, args.docIdBytes)
  } finally {
    zeroize(hash)
  }
}

/** Проверка формы записи, пришедшей с сервера (сервер видел все прошлые версии). */
export function isWrapRecord(v: unknown): v is WrapRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r['v'] !== 1) return false
  if (typeof r['wrapVer'] !== 'number' || !Number.isInteger(r['wrapVer']) || r['wrapVer'] < 1) {
    return false
  }
  if (typeof r['nonce'] !== 'string' || typeof r['ct'] !== 'string') return false
  if (tryB32decodeExact(r['nonce'], SIZES.NONCE_BYTES) === null) return false
  if (tryB32decodeExact(r['ct'], 32 + SIZES.GCM_TAG_BYTES) === null) return false
  try {
    validateKdfParams(r['kdf'] as KdfParams)
  } catch {
    return false
  }
  return true
}

export interface WrapArgs {
  docKey: Uint8Array
  linkSecret: Uint8Array
  docIdBytes: Uint8Array
  wrapVer: number
  kdf: KdfParams
  password?: string | null
}

/** ct = AES-GCM(KEK, K_doc), AAD = "EL1"‖KeyWrap‖docId — обёртка привязана к документу. */
export async function wrapDocKey(args: WrapArgs): Promise<WrapRecord> {
  if (args.docKey.length !== 32) throw new PasswordError('bad-wrap', 'K_doc must be 32 bytes')
  if (!Number.isInteger(args.wrapVer) || args.wrapVer < 1) {
    throw new PasswordError('bad-wrap', 'wrapVer must be a positive integer')
  }
  const kdf = validateKdfParams(args.kdf)
  const kek = await deriveKek({
    linkSecret: args.linkSecret,
    docIdBytes: args.docIdBytes,
    kdf,
    password: args.password ?? null,
  })
  const nonce = randomBytes(SIZES.NONCE_BYTES)
  try {
    const key = await importAesKey(kek)
    const ct = await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: buildAadBytes(PacketType.KeyWrap, args.docIdBytes) as BufferSource,
        tagLength: SIZES.GCM_TAG_BYTES * 8,
      },
      key,
      args.docKey as BufferSource,
    )
    return {
      v: 1,
      wrapVer: args.wrapVer,
      kdf,
      nonce: b32encode(nonce),
      ct: b32encode(new Uint8Array(ct)),
    }
  } finally {
    zeroize(kek)
  }
}

export interface UnwrapArgs {
  wrap: WrapRecord
  linkSecret: Uint8Array
  docIdBytes: Uint8Array
  password?: string | null
}

/** Шаг 7 открытия документа (§7.6). Неверный пароль → bad-password, а не мусорный ключ. */
export async function unwrapDocKey(args: UnwrapArgs): Promise<Uint8Array> {
  if (!isWrapRecord(args.wrap)) throw new PasswordError('bad-wrap', 'malformed wrap record')
  const nonce = b32decodeExact(args.wrap.nonce, SIZES.NONCE_BYTES)
  const ct = b32decodeExact(args.wrap.ct, 32 + SIZES.GCM_TAG_BYTES)
  const kek = await deriveKek({
    linkSecret: args.linkSecret,
    docIdBytes: args.docIdBytes,
    kdf: args.wrap.kdf,
    password: args.password ?? null,
  })
  try {
    const key = await importAesKey(kek)
    const pt = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: buildAadBytes(PacketType.KeyWrap, args.docIdBytes) as BufferSource,
        tagLength: SIZES.GCM_TAG_BYTES * 8,
      },
      key,
      ct as BufferSource,
    )
    return new Uint8Array(pt)
  } catch (e) {
    if (e instanceof EnvelopeError) throw e
    throw new PasswordError('bad-password', 'cannot unwrap K_doc: wrong password or damaged wrap')
  } finally {
    zeroize(kek)
  }
}

/** Максимальный виденный wrapVer и его alg — хранится локально и дублируется в DocMeta. */
export interface WrapSeen {
  wrapVer: number
  alg: KdfAlg
}

/**
 * Правила клиента §5.5. Все три обязательны:
 * 1. wrapVer меньше виденного — отказ;
 * 2. понижение alg на 'none' при том же или меньшем wrapVer — отказ;
 * 3. клампы KDF до запуска вычисления.
 */
export function assertWrapAcceptable(incoming: WrapRecord, seen: WrapSeen | null): void {
  if (!isWrapRecord(incoming)) throw new PasswordError('bad-wrap', 'malformed wrap record')
  validateKdfParams(incoming.kdf)
  if (seen === null) return
  if (incoming.wrapVer < seen.wrapVer) {
    throw new WrapRollbackError(
      `wrap rollback: seen wrapVer ${seen.wrapVer}, got ${incoming.wrapVer}`,
      seen.wrapVer,
      incoming.wrapVer,
    )
  }
  if (incoming.wrapVer === seen.wrapVer && incoming.kdf.alg !== seen.alg) {
    throw new WrapRollbackError(
      `wrap alg changed without wrapVer bump: ${seen.alg} → ${incoming.kdf.alg}`,
      seen.wrapVer,
      incoming.wrapVer,
    )
  }
}

/** Та же проверка без исключений — для мест, где нужен флаг, а не поток управления. */
export function isWrapAcceptable(incoming: WrapRecord, seen: WrapSeen | null): boolean {
  try {
    assertWrapAcceptable(incoming, seen)
    return true
  } catch {
    return false
  }
}

export function wrapSeenOf(wrap: WrapRecord): WrapSeen {
  return { wrapVer: wrap.wrapVer, alg: wrap.kdf.alg }
}

export interface WrapContext {
  linkSecret: Uint8Array
  docIdBytes: Uint8Array
  /** Текущая запись: из неё берётся wrapVer, новая всегда wrapVer + 1. */
  wrap: WrapRecord
}

async function rewrap(
  ctx: WrapContext,
  currentPassword: string | null,
  nextKdf: KdfParams,
  nextPassword: string | null,
): Promise<WrapRecord> {
  const docKey = await unwrapDocKey({
    wrap: ctx.wrap,
    linkSecret: ctx.linkSecret,
    docIdBytes: ctx.docIdBytes,
    password: currentPassword,
  })
  try {
    return await wrapDocKey({
      docKey,
      linkSecret: ctx.linkSecret,
      docIdBytes: ctx.docIdBytes,
      wrapVer: ctx.wrap.wrapVer + 1,
      kdf: nextKdf,
      password: nextPassword,
    })
  } finally {
    zeroize(docKey)
  }
}

/** Включение пароля: меняется только wrap-record, ссылка та же (§5.5). */
export async function setPassword(
  ctx: WrapContext,
  password: string,
  opts: { alg?: PasswordKdfAlg } = {},
): Promise<WrapRecord> {
  if (ctx.wrap.kdf.alg !== 'none') {
    throw new PasswordError('password-unexpected', 'password already set, use changePassword')
  }
  requireStrongEnough(password)
  return rewrap(ctx, null, newKdfParams(opts.alg ?? preferredPasswordKdf()), password)
}

export async function changePassword(
  ctx: WrapContext,
  current: string,
  next: string,
  opts: { alg?: PasswordKdfAlg } = {},
): Promise<WrapRecord> {
  if (ctx.wrap.kdf.alg === 'none') {
    throw new PasswordError('password-required', 'no password set, use setPassword')
  }
  requireStrongEnough(next)
  return rewrap(ctx, current, newKdfParams(opts.alg ?? preferredPasswordKdf()), next)
}

/** Легальное снятие пароля всегда увеличивает wrapVer. */
export async function removePassword(ctx: WrapContext, current: string): Promise<WrapRecord> {
  if (ctx.wrap.kdf.alg === 'none') {
    throw new PasswordError('password-required', 'no password set')
  }
  return rewrap(ctx, current, { alg: 'none' }, null)
}

export interface GeneratedPassphrase {
  words: string[]
  text: string
  bits: number
}

/** 5 слов из русского списка 2048 = 55 бит (§5.4): KDF не спасает слабый пароль, спасает энтропия. */
export function generatePassphrase(wordCount: number = C.PASSPHRASE_WORDS): GeneratedPassphrase {
  if (!Number.isInteger(wordCount) || wordCount < 1 || wordCount > 24) {
    throw new PasswordError('password-weak', 'wordCount out of range')
  }
  const idx = new Uint16Array(wordCount)
  globalThis.crypto.getRandomValues(idx)
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    // 2048 = 2^11: маска не даёт смещения
    words.push(PASSPHRASE_WORDLIST[(idx[i] as number) & 0x7ff] as string)
  }
  idx.fill(0)
  return { words, text: words.join(' '), bits: wordCount * PASSPHRASE_WORD_BITS }
}

export interface PasswordStrength {
  bits: number
  verdict: 'reject' | 'weak' | 'ok' | 'strong'
}

const WORD_SET: ReadonlySet<string> = new Set(PASSPHRASE_WORDLIST)

function charsetBits(pw: string): number {
  let lowerLat = false
  let upperLat = false
  let lowerCyr = false
  let upperCyr = false
  let digit = false
  let other = false
  for (const ch of pw) {
    if (ch >= 'a' && ch <= 'z') lowerLat = true
    else if (ch >= 'A' && ch <= 'Z') upperLat = true
    else if (ch >= '0' && ch <= '9') digit = true
    else if (ch >= 'а' && ch <= 'я') lowerCyr = true
    else if (ch >= 'А' && ch <= 'Я') upperCyr = true
    else other = true
  }
  let size = 0
  if (lowerLat) size += 26
  if (upperLat) size += 26
  if (lowerCyr) size += 32
  if (upperCyr) size += 32
  if (digit) size += 10
  if (other) size += 33
  return size === 0 ? 0 : Math.log2(size)
}

/** Оценка энтропии. Ниже 40 бит — отказ с объяснением (§5.4). */
export function estimatePassword(pw: string): PasswordStrength {
  const norm = normalizePassword(pw).trim()
  if (norm.length === 0) return { bits: 0, verdict: 'reject' }

  const tokens = norm
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((t) => t.length > 0)
  let bits: number
  if (tokens.length >= 2 && tokens.every((t) => WORD_SET.has(t))) {
    bits = tokens.length * PASSPHRASE_WORD_BITS
  } else {
    // повторяющиеся символы дают меньше энтропии, чем разные
    const unique = new Set([...norm]).size
    const effective = unique + (norm.length - unique) * 0.5
    bits = Math.floor(effective * charsetBits(norm))
  }
  const verdict =
    bits < C.PASSWORD_MIN_BITS
      ? 'reject'
      : bits < 50
        ? 'weak'
        : bits < C.PASSPHRASE_BITS
          ? 'ok'
          : 'strong'
  return { bits, verdict }
}

function requireStrongEnough(pw: string): void {
  const { bits, verdict } = estimatePassword(pw)
  if (verdict === 'reject') {
    throw new PasswordError('password-weak', `password entropy too low: ${bits} bits`)
  }
}

/** Совпадают ли два ключа документа (для проверки, что перезаворачивание не потеряло K_doc). */
export function sameDocKey(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(a, b)
}
