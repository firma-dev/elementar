import { describe, expect, it } from 'vitest'
import { C, KDF_LIMITS, SIZES } from '@elementar/proto'
import type { WrapRecord } from '@elementar/proto'
import {
  KDF_DEFAULTS,
  PASSPHRASE_WORDLIST,
  PasswordError,
  WrapRollbackError,
  assertWrapAcceptable,
  changePassword,
  derivePasswordHash,
  estimatePassword,
  generatePassphrase,
  isWrapAcceptable,
  isWrapRecord,
  newKdfParams,
  normalizePassword,
  removePassword,
  setPassword,
  unwrapDocKey,
  validateKdfParams,
  wrapDocKey,
  wrapSeenOf,
} from '../../src/crypto/password.js'
import { generateDocKey, timingSafeEqual } from '../../src/crypto/keys.js'
import { b32encode } from '../../src/crypto/b32.js'
import { createDocumentKeys } from '../../src/crypto/link.js'

const PW = 'сокол ландыш верстак печенье гамак'
const PW2 = 'радуга поленница чайник янтарь скрипка'
/** Быстрый KDF: содержательно проверяется схема, а не скорость argon2. */
const FAST = { alg: 'pbkdf2-sha256', i: KDF_LIMITS.pbkdf2.iMin } as const

const fastKdf = () => ({ ...FAST, salt: newKdfParams('pbkdf2-sha256').salt }) as const

describe('wrap-record и пароль', () => {
  it('умолчания KDF соответствуют §5.4', () => {
    expect(KDF_DEFAULTS.argon2id).toEqual({ m: 65_536, t: 3, p: 1, outLen: 32 })
    expect(KDF_DEFAULTS.pbkdf2.iterations).toBe(600_000)
    expect(KDF_DEFAULTS.saltBytes).toBe(16)
    expect(KDF_DEFAULTS.targetMs).toBe(700)
  })

  it('клампы: параметры за границей — ошибка, а не исполнение', () => {
    const salt = b32encode(new Uint8Array(16))
    expect(() => validateKdfParams({ alg: 'none' })).not.toThrow()
    expect(() => validateKdfParams({ alg: 'argon2id', m: 65_536, t: 3, p: 1, salt })).not.toThrow()
    // m = 4 GiB — DoS одной строкой
    expect(() =>
      validateKdfParams({ alg: 'argon2id', m: 4_194_304, t: 3, p: 1, salt }),
    ).toThrowError(PasswordError)
    expect(() => validateKdfParams({ alg: 'argon2id', m: 65_536, t: 999, p: 1, salt })).toThrow()
    expect(() => validateKdfParams({ alg: 'argon2id', m: 1024, t: 3, p: 1, salt })).toThrow()
    expect(() => validateKdfParams({ alg: 'argon2id', m: 65_536, t: 3, p: 9, salt })).toThrow()
    expect(() => validateKdfParams({ alg: 'pbkdf2-sha256', i: 1000, salt })).toThrow()
    expect(() => validateKdfParams({ alg: 'pbkdf2-sha256', i: 9_000_000, salt })).toThrow()
    expect(() =>
      validateKdfParams({ alg: 'pbkdf2-sha256', i: 600_000, salt: 'НЕВЕРНАЯСОЛЬ' }),
    ).toThrow()
    expect(() => validateKdfParams({ alg: 'scrypt' } as unknown as { alg: 'none' })).toThrowError(
      PasswordError,
    )
  })

  it('запредельные параметры не доходят до вычисления', async () => {
    const salt = b32encode(new Uint8Array(16))
    await expect(
      derivePasswordHash(PW, { alg: 'argon2id', m: 1_048_576, t: 8, p: 4, salt }),
    ).rejects.toThrowError(PasswordError)
  })

  it('round-trip без пароля: K_doc всегда завёрнут', async () => {
    const keys = createDocumentKeys()
    const docKey = generateDocKey()
    const wrap = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 1,
      kdf: { alg: 'none' },
    })
    expect(wrap.v).toBe(1)
    expect(wrap.wrapVer).toBe(1)
    expect(isWrapRecord(wrap)).toBe(true)
    // ct = K_doc(32) + tag(16) = 48 байт
    expect(wrap.ct).toHaveLength(Math.ceil(((32 + SIZES.GCM_TAG_BYTES) * 8) / 5))
    const out = await unwrapDocKey({
      wrap,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
    })
    expect(timingSafeEqual(out, docKey)).toBe(true)
  })

  it('round-trip с паролем и отказ на неверном пароле', async () => {
    const keys = createDocumentKeys()
    const docKey = generateDocKey()
    const wrap = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 2,
      kdf: fastKdf(),
      password: PW,
    })
    const ok = await unwrapDocKey({
      wrap,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      password: PW,
    })
    expect(timingSafeEqual(ok, docKey)).toBe(true)

    await expect(
      unwrapDocKey({
        wrap,
        linkSecret: keys.linkSecret,
        docIdBytes: keys.docIdBytes,
        password: PW2,
      }),
    ).rejects.toMatchObject({ reason: 'bad-password' })

    // пароль без ссылки не даёт ничего
    const other = createDocumentKeys()
    await expect(
      unwrapDocKey({
        wrap,
        linkSecret: other.linkSecret,
        docIdBytes: keys.docIdBytes,
        password: PW,
      }),
    ).rejects.toMatchObject({ reason: 'bad-password' })

    // ссылка без пароля тоже
    await expect(
      unwrapDocKey({ wrap, linkSecret: keys.linkSecret, docIdBytes: keys.docIdBytes }),
    ).rejects.toMatchObject({ reason: 'password-required' })
  })

  it('wrap привязан к документу через AAD', async () => {
    const keys = createDocumentKeys()
    const wrap = await wrapDocKey({
      docKey: generateDocKey(),
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 1,
      kdf: { alg: 'none' },
    })
    const foreign = createDocumentKeys()
    await expect(
      unwrapDocKey({ wrap, linkSecret: keys.linkSecret, docIdBytes: foreign.docIdBytes }),
    ).rejects.toMatchObject({ reason: 'bad-password' })
  })

  it('включение, смена и снятие пароля меняют только wrap и всегда двигают wrapVer', async () => {
    const keys = createDocumentKeys()
    const docKey = generateDocKey()
    const wrap1 = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 1,
      kdf: { alg: 'none' },
    })
    const ctx1 = { linkSecret: keys.linkSecret, docIdBytes: keys.docIdBytes, wrap: wrap1 }

    const wrap2 = await setPassword(ctx1, PW, { alg: 'pbkdf2-sha256' })
    expect(wrap2.wrapVer).toBe(2)
    expect(wrap2.kdf.alg).toBe('pbkdf2-sha256')

    const ctx2 = { ...ctx1, wrap: wrap2 }
    const wrap3 = await changePassword(ctx2, PW, PW2, { alg: 'pbkdf2-sha256' })
    expect(wrap3.wrapVer).toBe(3)
    expect(wrap3.nonce).not.toBe(wrap2.nonce)

    const ctx3 = { ...ctx1, wrap: wrap3 }
    const wrap4 = await removePassword(ctx3, PW2)
    expect(wrap4.wrapVer).toBe(4)
    expect(wrap4.kdf.alg).toBe('none')

    // K_doc всё это время один и тот же — документ не перешифровывается
    const final = await unwrapDocKey({
      wrap: wrap4,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
    })
    expect(timingSafeEqual(final, docKey)).toBe(true)

    await expect(setPassword(ctx2, PW2)).rejects.toMatchObject({ reason: 'password-unexpected' })
    await expect(removePassword(ctx1, PW)).rejects.toMatchObject({ reason: 'password-required' })
    await expect(changePassword(ctx1, PW, PW2)).rejects.toMatchObject({
      reason: 'password-required',
    })
  })

  it('слабый пароль не принимается при установке', async () => {
    const keys = createDocumentKeys()
    const wrap = await wrapDocKey({
      docKey: generateDocKey(),
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 1,
      kdf: { alg: 'none' },
    })
    await expect(
      setPassword({ linkSecret: keys.linkSecret, docIdBytes: keys.docIdBytes, wrap }, '123456'),
    ).rejects.toMatchObject({ reason: 'password-weak' })
  })

  it('понижение wrapVer — громкая ошибка WrapRollback', async () => {
    const keys = createDocumentKeys()
    const docKey = generateDocKey()
    const v1 = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 1,
      kdf: { alg: 'none' },
    })
    const v2 = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 2,
      kdf: fastKdf(),
      password: PW,
    })
    const seen = wrapSeenOf(v2)
    expect(seen).toEqual({ wrapVer: 2, alg: 'pbkdf2-sha256' })

    expect(() => assertWrapAcceptable(v2, seen)).not.toThrow()
    expect(() => assertWrapAcceptable(v1, seen)).toThrowError(WrapRollbackError)
    expect(isWrapAcceptable(v1, seen)).toBe(false)
    expect(isWrapAcceptable(v2, null)).toBe(true)

    try {
      assertWrapAcceptable(v1, seen)
    } catch (e) {
      expect((e as WrapRollbackError).name).toBe('WrapRollback')
      expect((e as WrapRollbackError).seenVer).toBe(2)
      expect((e as WrapRollbackError).incomingVer).toBe(1)
    }
  })

  it('понижение alg на none при том же wrapVer — отказ', async () => {
    const keys = createDocumentKeys()
    const docKey = generateDocKey()
    // сервер отдаёт валидную обёртку того же K_doc под KEK0 с тем же номером версии
    const sneaky = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 5,
      kdf: { alg: 'none' },
    })
    expect(() => assertWrapAcceptable(sneaky, { wrapVer: 5, alg: 'argon2id' })).toThrowError(
      WrapRollbackError,
    )
    expect(() => assertWrapAcceptable(sneaky, { wrapVer: 5, alg: 'none' })).not.toThrow()
    // легальное снятие пароля увеличивает wrapVer
    expect(() => assertWrapAcceptable(sneaky, { wrapVer: 4, alg: 'argon2id' })).not.toThrow()
  })

  it('мусорная wrap-запись отвергается формой', () => {
    expect(isWrapRecord(null)).toBe(false)
    expect(isWrapRecord({ v: 2, wrapVer: 1, kdf: { alg: 'none' }, nonce: '00', ct: '00' })).toBe(
      false,
    )
    expect(isWrapRecord({ v: 1, wrapVer: 0, kdf: { alg: 'none' }, nonce: '00', ct: '00' })).toBe(
      false,
    )
    const bad = {
      v: 1,
      wrapVer: 1,
      kdf: { alg: 'argon2id', m: 4_194_304, t: 3, p: 1, salt: b32encode(new Uint8Array(16)) },
      nonce: b32encode(new Uint8Array(12)),
      ct: b32encode(new Uint8Array(48)),
    } as unknown as WrapRecord
    expect(isWrapRecord(bad)).toBe(false)
    expect(() => assertWrapAcceptable(bad, null)).toThrowError(PasswordError)
  })

  it('argon2id остаётся рабочим путём с боевыми параметрами', async () => {
    const keys = createDocumentKeys()
    const docKey = generateDocKey()
    const wrap = await wrapDocKey({
      docKey,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      wrapVer: 1,
      kdf: newKdfParams('argon2id'),
      password: PW,
    })
    expect(wrap.kdf.alg).toBe('argon2id')
    const out = await unwrapDocKey({
      wrap,
      linkSecret: keys.linkSecret,
      docIdBytes: keys.docIdBytes,
      password: PW,
    })
    expect(timingSafeEqual(out, docKey)).toBe(true)
  })
})

describe('парольная фраза', () => {
  it('список ровно 2048 слов, уникальных и без не-кириллицы', () => {
    expect(PASSPHRASE_WORDLIST).toHaveLength(2048)
    expect(new Set(PASSPHRASE_WORDLIST).size).toBe(2048)
    for (const w of PASSPHRASE_WORDLIST) expect(w).toMatch(/^[а-я]{3,11}$/)
  })

  it('5 слов = 55 бит', () => {
    const p = generatePassphrase()
    expect(p.words).toHaveLength(C.PASSPHRASE_WORDS)
    expect(p.bits).toBe(C.PASSPHRASE_BITS)
    expect(p.text).toBe(p.words.join(' '))
    for (const w of p.words) expect(PASSPHRASE_WORDLIST).toContain(w)
    expect(generatePassphrase(4).bits).toBe(44)
  })

  it('фразы не повторяются', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(generatePassphrase().text)
    expect(seen.size).toBe(200)
  })

  it('оценка энтропии: ниже 40 бит — отказ', () => {
    expect(estimatePassword('123456').verdict).toBe('reject')
    expect(estimatePassword('пароль').verdict).toBe('reject')
    expect(estimatePassword('').verdict).toBe('reject')
    expect(estimatePassword(generatePassphrase().text)).toEqual({ bits: 55, verdict: 'strong' })
    expect(estimatePassword('сокол ландыш верстак печенье').bits).toBe(44)
    expect(estimatePassword('Zq7#pL2v!Kd8@Rn4xY').verdict).not.toBe('reject')
  })

  it('нормализация пароля: NFKC, режутся только переводы строк', () => {
    expect(normalizePassword('пароль\n')).toBe('пароль')
    expect(normalizePassword('па\r\nроль')).toBe('пароль')
    expect(normalizePassword(' пароль ')).toBe(' пароль ')
    expect(normalizePassword('ﬁх')).toBe('fiх')
  })

  it('один и тот же пароль в разных формах Unicode даёт один ключ', async () => {
    const salt = newKdfParams('pbkdf2-sha256').salt
    const a = await derivePasswordHash('е́жик '.trim(), { ...FAST, salt })
    const b = await derivePasswordHash('е́жик', { ...FAST, salt })
    expect([...a]).toEqual([...b])
  })
})
