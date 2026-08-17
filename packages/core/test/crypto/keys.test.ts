/**
 * Замороженные векторы дерева ключей (§4.3). Если хоть один из них изменится —
 * все существующие документы перестанут открываться. Правка допустима только вместе
 * с новой версией протокола.
 *
 * Каждый вектор дополнительно сверяется с независимой реализацией (@noble/hashes),
 * чтобы заморозить не собственную ошибку, а настоящий HKDF-SHA256.
 */
import { describe, expect, it } from 'vitest'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js'
import { INFO } from '@elementar/proto'
import {
  concatBytes,
  deriveKek0,
  deriveKek1,
  deriveLinkIdentity,
  deriveSignSeed,
  docIdFromBytes,
  docIdToBytes,
  generateDocKey,
  hkdfSha256,
  timingSafeEqual,
  zeroize,
} from '../../src/crypto/keys.js'
import { b32encode } from '../../src/crypto/b32.js'
import { derivePasswordHash } from '../../src/crypto/password.js'

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

const utf8 = new TextEncoder()

/** Тестовый K_link: байты 0x00…0x1f. */
const LINK_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i)
/** Тестовый docId: байты 0xf0…0xe5. */
const DOC_ID_BYTES = Uint8Array.from({ length: 12 }, (_, i) => 0xf0 - i)
const SALT = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const PASSWORD = 'сокол ландыш верстак печенье гамак'

const V = {
  docId: 'Y3QYXVFCXFNEKT77WVJG',
  signSeed: 'd27b56d5ecede8a8b1b41a1d05aa18617486f1bd83f91d567b8f1187bfe8e89f',
  kek0: 'f5659fe0da902c66fd02e946e6b8587aa31abacd5da45b9e58f6101ef112eaf2',
  saltB32: '041061050R3GG28A1C60T3GF20',
  argon2Hash: '7eade883b6b7d3bb6e58223fa332a39586d3f20ce6809eed8db53cb51bafa592',
  pbkdf2Hash: '8e474f02501717519b5fc39f9944f513496a50691314404d85c0780c25d58a56',
  kek1Argon: '28f71bff9ae2bda3030af23816366d61215b446f4f308f11c77a54e9dcdb7211',
  kek1Pbkdf2: 'c4dd77e1b886a40fa65d4f973af60f04e308cea605c87113ab730732bb4e322d',
} as const

describe('дерево ключей', () => {
  it('docId кодируется и разбирается без потерь', () => {
    expect(docIdFromBytes(DOC_ID_BYTES)).toBe(V.docId)
    expect([...docIdToBytes(V.docId)]).toEqual([...DOC_ID_BYTES])
    expect(b32encode(SALT)).toBe(V.saltB32)
  })

  it('signSeed — замороженный вектор и совпадение с @noble/hashes', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    expect(hex(seed)).toBe(V.signSeed)
    const reference = hkdf(nobleSha256, LINK_SECRET, DOC_ID_BYTES, utf8.encode(INFO.WRITE_KEY), 32)
    expect(hex(reference)).toBe(V.signSeed)
  })

  it('KEK0 — замороженный вектор и совпадение с @noble/hashes', async () => {
    const kek0 = await deriveKek0(LINK_SECRET, DOC_ID_BYTES)
    expect(hex(kek0)).toBe(V.kek0)
    const reference = hkdf(nobleSha256, LINK_SECRET, DOC_ID_BYTES, utf8.encode(INFO.KEK), 32)
    expect(hex(reference)).toBe(V.kek0)
  })

  it('argon2id даёт замороженный хеш и совпадает с @noble/hashes', async () => {
    const h = await derivePasswordHash(PASSWORD, {
      alg: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
      salt: V.saltB32,
    })
    expect(hex(h)).toBe(V.argon2Hash)
    const reference = nobleArgon2id(utf8.encode(PASSWORD), SALT, {
      t: 3,
      m: 65536,
      p: 1,
      dkLen: 32,
    })
    expect(hex(reference)).toBe(V.argon2Hash)
  })

  it('pbkdf2-sha256 даёт замороженный хеш', async () => {
    const h = await derivePasswordHash(PASSWORD, {
      alg: 'pbkdf2-sha256',
      i: 100_000,
      salt: V.saltB32,
    })
    expect(hex(h)).toBe(V.pbkdf2Hash)
  })

  it('KEK1 = HKDF(K_link ‖ hash(pw)) — замороженные векторы обоих KDF', async () => {
    const a2 = await derivePasswordHash(PASSWORD, {
      alg: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
      salt: V.saltB32,
    })
    expect(hex(await deriveKek1(LINK_SECRET, a2, DOC_ID_BYTES))).toBe(V.kek1Argon)

    const pb = await derivePasswordHash(PASSWORD, {
      alg: 'pbkdf2-sha256',
      i: 100_000,
      salt: V.saltB32,
    })
    expect(hex(await deriveKek1(LINK_SECRET, pb, DOC_ID_BYTES))).toBe(V.kek1Pbkdf2)

    const reference = hkdf(
      nobleSha256,
      concatBytes(LINK_SECRET, a2),
      DOC_ID_BYTES,
      utf8.encode(INFO.KEK),
      32,
    )
    expect(hex(reference)).toBe(V.kek1Argon)
  })

  it('KEK0 и KEK1 не совпадают, и оба зависят от docId', async () => {
    const kek0 = await deriveKek0(LINK_SECRET, DOC_ID_BYTES)
    const other = await deriveKek0(
      LINK_SECRET,
      Uint8Array.from({ length: 12 }, (_, i) => i),
    )
    expect(hex(kek0)).not.toBe(hex(other))
    const a2 = await derivePasswordHash(PASSWORD, {
      alg: 'argon2id',
      m: 8192,
      t: 1,
      p: 1,
      salt: V.saltB32,
    })
    expect(hex(await deriveKek1(LINK_SECRET, a2, DOC_ID_BYTES))).not.toBe(hex(kek0))
  })

  it('deriveLinkIdentity собирает всё за один шаг', async () => {
    const id = await deriveLinkIdentity(V.docId, LINK_SECRET)
    expect(id.docId).toBe(V.docId)
    expect([...id.docIdBytes]).toEqual([...DOC_ID_BYTES])
    expect(hex(id.signSeed)).toBe(V.signSeed)
    expect(hex(id.kek0)).toBe(V.kek0)
  })

  it('деривации отвергают ключи неверной длины', async () => {
    await expect(deriveSignSeed(new Uint8Array(31), DOC_ID_BYTES)).rejects.toThrow()
    await expect(deriveKek0(LINK_SECRET, new Uint8Array(11))).rejects.toThrow()
    await expect(deriveKek1(LINK_SECRET, new Uint8Array(0), DOC_ID_BYTES)).rejects.toThrow()
  })

  it('K_doc случаен и не выводится из K_link', () => {
    const a = generateDocKey()
    const b = generateDocKey()
    expect(a).toHaveLength(32)
    expect(timingSafeEqual(a, b)).toBe(false)
  })

  it('hkdfSha256 отдаёт произвольную длину', async () => {
    const out = await hkdfSha256(LINK_SECRET, DOC_ID_BYTES, 'elementar/1/test', 64)
    expect(out).toHaveLength(64)
    const reference = hkdf(
      nobleSha256,
      LINK_SECRET,
      DOC_ID_BYTES,
      utf8.encode('elementar/1/test'),
      64,
    )
    expect(hex(out)).toBe(hex(reference))
  })

  it('zeroize и timingSafeEqual', () => {
    const a = Uint8Array.of(1, 2, 3)
    const b = Uint8Array.of(1, 2, 3)
    expect(timingSafeEqual(a, b)).toBe(true)
    expect(timingSafeEqual(a, Uint8Array.of(1, 2))).toBe(false)
    zeroize(a)
    expect([...a]).toEqual([0, 0, 0])
  })
})
