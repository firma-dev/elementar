import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ORIGIN,
  API_BASE,
  API_ORIGIN,
  BUCKETS,
  C,
  CROCKFORD_ALPHABET,
  ELM_ERROR_CODES,
  ERROR_STATUS,
  KDF_LIMITS,
  NOT_FOUND_BODY,
  NOT_FOUND_BODY_BYTES,
  ORIGIN,
  OP_COST,
  PATHS,
  SIZES,
  asDocId,
  b32CharLen,
  docUrl,
  groupForDisplay,
  isCrockford,
  isDocId,
  isFragment,
  isElmErrorCode,
  missCost,
  normalizeB32Input,
  pushDeltasCost,
  putSnapshotCost,
} from '../src/index.js'

describe('константы приложения Б', () => {
  it('крипта и транспорт', () => {
    expect(C.DOC_ID_BYTES).toBe(12)
    expect(C.DOC_ID_CHARS).toBe(20)
    expect(C.LINK_SECRET_BYTES).toBe(32)
    expect(C.FRAGMENT_BYTES).toBe(33)
    expect(C.FRAGMENT_CHARS).toBe(53)
    expect(C.NONCE_BYTES).toBe(12)
    expect(C.SESSION_TAG_BYTES).toBe(8)
    expect(C.GCM_TAG_BYTES).toBe(16)
    expect(C.HEADER_BYTES).toBe(16)
    expect(C.AAD_BYTES).toBe(16)
    expect(C.SIG_SKEW_MS).toBe(120_000)
    expect(C.SIG_NONCE_TTL_MS).toBe(300_000)
    expect(C.INVITE_TTL_MS).toBe(900_000)
    expect(C.MAX_DELTA_BYTES).toBe(65_536)
    expect(C.MAX_PACKET_BYTES).toBe(1_048_576)
    expect(C.MAX_FRAMES).toBe(256)
    expect(C.MAX_SNAPSHOT_BYTES).toBe(2_097_152)
    expect(C.INLINE_SNAPSHOT_BYTES).toBe(262_144)
    expect(C.WS_FRAME_MAX).toBe(131_072)
  })

  it('инварианты между порогами', () => {
    // конверт: 3 magic + 1 type + 12 nonce = 16, накладные 32 байта на пакет
    expect(C.HEADER_BYTES).toBe(3 + 1 + C.NONCE_BYTES)
    expect(C.HEADER_BYTES + C.GCM_TAG_BYTES).toBe(32)
    expect(C.NONCE_BYTES).toBe(C.SESSION_TAG_BYTES + 4)
    expect(C.AAD_BYTES).toBe(3 + 1 + C.DOC_ID_BYTES)
    expect(C.FRAGMENT_BYTES).toBe(1 + C.LINK_SECRET_BYTES)
    expect(C.LOG_SOFT_COUNT).toBeLessThan(C.LOG_HARD_COUNT)
    expect(C.LOG_HARD_COUNT).toBeLessThan(C.LOG_CEIL_COUNT)
    expect(C.LOG_SOFT_BYTES).toBeLessThan(C.LOG_HARD_BYTES)
    expect(C.LOG_HARD_BYTES).toBeLessThan(C.LOG_CEIL_BYTES)
    expect(C.LOG_CEIL_BYTES).toBeLessThan(C.DOC_TOTAL_BYTES)
    expect(C.INLINE_SNAPSHOT_BYTES).toBeLessThan(C.MAX_SNAPSHOT_BYTES)
    expect(C.MAX_DELTA_BYTES).toBeLessThan(C.MAX_PACKET_BYTES)
    expect(C.PRESENCE_BEAT_MS * 2).toBe(C.PRESENCE_TTL_MS)
    expect(C.BLOCK_MAX_MS).toBe(900_000)
    expect(C.MIN_404_MS).toBe(25)
  })

  it('размеры в keys.SIZES не расходятся с C', () => {
    expect(SIZES.DOC_ID_BYTES).toBe(C.DOC_ID_BYTES)
    expect(SIZES.FRAGMENT_CHARS).toBe(C.FRAGMENT_CHARS)
    expect(SIZES.SIG_NONCE_BYTES).toBe(C.SIG_NONCE_BYTES)
    expect(SIZES.CHAIN_HASH_BYTES).toBe(C.CHAIN_HASH_BYTES)
    expect(SIZES.KDF_SALT_BYTES).toBe(C.KDF_SALT_BYTES)
  })

  it('число символов base32 сходится с числом байт', () => {
    expect(b32CharLen(C.DOC_ID_BYTES)).toBe(C.DOC_ID_CHARS)
    expect(b32CharLen(C.FRAGMENT_BYTES)).toBe(C.FRAGMENT_CHARS)
    expect(b32CharLen(8)).toBe(13)
  })

  it('цены операций и штраф за промах', () => {
    expect(OP_COST.getDoc).toBe(1)
    expect(OP_COST.getDeltas).toBe(2)
    expect(OP_COST.getSnapshot).toBe(3)
    expect(OP_COST.createDoc).toBe(25)
    expect(OP_COST.wsUpgrade).toBe(5)
    expect(OP_COST.llm).toBe(50)
    expect(pushDeltasCost(0)).toBe(4)
    expect(pushDeltasCost(16_384)).toBe(5)
    expect(pushDeltasCost(16_385)).toBe(6)
    expect(putSnapshotCost(0)).toBe(10)
    expect(putSnapshotCost(65_536)).toBe(12)
    expect([0, 1, 2, 3, 4, 5, 99].map(missCost)).toEqual([5, 10, 20, 40, 80, 80, 80])
    expect(BUCKETS.auth).toEqual({ capacity: 240, refillPerSec: 4 })
    expect(BUCKETS.miss).toEqual({ capacity: 20, refillPerSec: 0.2 })
  })

  it('клампы KDF', () => {
    expect(KDF_LIMITS.argon2id.mMin).toBeLessThanOrEqual(C.ARGON2_M_KIB)
    expect(KDF_LIMITS.argon2id.mMax).toBeGreaterThanOrEqual(C.ARGON2_M_KIB)
    expect(KDF_LIMITS.argon2id.tMax).toBeGreaterThanOrEqual(C.ARGON2_T)
    expect(KDF_LIMITS.pbkdf2.iMin).toBeLessThanOrEqual(C.PBKDF2_ITERATIONS)
    expect(KDF_LIMITS.pbkdf2.iMax).toBeGreaterThanOrEqual(C.PBKDF2_ITERATIONS)
  })
})

describe('коды ошибок', () => {
  it('у каждого кода есть статус и он из документа', () => {
    expect(ELM_ERROR_CODES.length).toBe(19)
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ELM_ERROR_CODES].sort())
    expect(ERROR_STATUS.ELM_BAD_FRAME).toBe(400)
    expect(ERROR_STATUS.ELM_SIG_REPLAY).toBe(401)
    expect(ERROR_STATUS.ELM_CHALLENGE).toBe(403)
    expect(ERROR_STATUS.ELM_NOT_FOUND).toBe(404)
    expect(ERROR_STATUS.ELM_UNSAFE_BASE).toBe(409)
    expect(ERROR_STATUS.ELM_TOO_LARGE).toBe(413)
    expect(ERROR_STATUS.ELM_FROZEN).toBe(423)
    expect(ERROR_STATUS.ELM_RATE_LIMITED).toBe(429)
    expect(ERROR_STATUS.ELM_QUOTA_DOC_FULL).toBe(507)
    expect(ERROR_STATUS.ELM_SHUTDOWN).toBe(503)
    expect(ERROR_STATUS.ELM_INTERNAL).toBe(500)
  })

  it('isElmErrorCode', () => {
    expect(isElmErrorCode('ELM_NOT_FOUND')).toBe(true)
    expect(isElmErrorCode('ELM_WAT')).toBe(false)
    expect(isElmErrorCode(42)).toBe(false)
  })

  it('единый 404 — чистый ASCII с фиксированной длиной', () => {
    expect(JSON.parse(NOT_FOUND_BODY)).toEqual({
      error: { code: 'ELM_NOT_FOUND', message: 'Not found' },
    })
    expect(new TextEncoder().encode(NOT_FOUND_BODY).length).toBe(NOT_FOUND_BODY_BYTES)
  })
})

describe('форматы docId и фрагмента', () => {
  const id = 'K7M4Q8XB2NJ0PRTV5W3Z'

  it('алфавит Crockford без I L O U', () => {
    expect(CROCKFORD_ALPHABET.length).toBe(32)
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32)
    for (const c of 'ILOU') expect(CROCKFORD_ALPHABET).not.toContain(c)
  })

  it('docId — ровно 20 канонических символов', () => {
    expect(isDocId(id)).toBe(true)
    expect(asDocId(id)).toBe(id)
    expect(isDocId(id.toLowerCase())).toBe(false)
    expect(isDocId(id.slice(0, 19))).toBe(false)
    expect(isDocId(`${id}A`)).toBe(false)
    expect(isDocId('K7M4Q8XB2NJ0PRTV5W3I')).toBe(false)
    expect(isDocId('K7M4Q-8XB2N-J0PRT-V5W3Z')).toBe(false)
    expect(asDocId('нет')).toBeNull()
  })

  it('фрагмент — 53 символа', () => {
    expect(isFragment('A'.repeat(C.FRAGMENT_CHARS))).toBe(true)
    expect(isFragment('A'.repeat(C.FRAGMENT_CHARS - 1))).toBe(false)
    expect(isFragment(`U${'A'.repeat(C.FRAGMENT_CHARS - 1)}`)).toBe(false)
  })

  it('нормализация ввода человеком', () => {
    expect(normalizeB32Input('k7m4q-8xb2n')).toBe('K7M4Q8XB2N')
    expect(normalizeB32Input('IlO oO')).toBe('11000')
    expect(normalizeB32Input('AB U')).toBeNull()
    expect(normalizeB32Input('AB!')).toBeNull()
    expect(isCrockford('K7M4Q')).toBe(true)
    expect(isCrockford('k7m4q')).toBe(false)
  })

  it('отображение группами по 5', () => {
    expect(groupForDisplay(id)).toBe('K7M4Q-8XB2N-J0PRT-V5W3Z')
  })
})

describe('домены и пути', () => {
  it('домен живёт в одном месте и он ASCII', () => {
    for (const o of [ORIGIN, API_ORIGIN, ALLOWED_ORIGIN]) {
      expect(o).toMatch(/^https:\/\/[a-z0-9.-]+$/)
    }
    expect(ALLOWED_ORIGIN).toBe(ORIGIN)
    expect(API_BASE).toBe(`${API_ORIGIN}/v1`)
    expect(docUrl('/p', 'K7M4Q8XB2NJ0PRTV5W3Z', 'A'.repeat(53))).toBe(
      `${ORIGIN}/p/K7M4Q8XB2NJ0PRTV5W3Z#${'A'.repeat(53)}`,
    )
  })

  it('пути эндпоинтов из §8.5', () => {
    const id = 'K7M4Q8XB2NJ0PRTV5W3Z'
    expect(PATHS.health).toBe('/v1/health')
    expect(PATHS.challenge).toBe('/v1/challenge')
    expect(PATHS.docs).toBe('/v1/docs')
    expect(PATHS.doc(id)).toBe(`/v1/docs/${id}`)
    expect(PATHS.deltas(id)).toBe(`/v1/docs/${id}/deltas`)
    expect(PATHS.snapshot(id)).toBe(`/v1/docs/${id}/snapshot`)
    expect(PATHS.wrap(id)).toBe(`/v1/docs/${id}/wrap`)
    expect(PATHS.undelete(id)).toBe(`/v1/docs/${id}/undelete`)
    expect(PATHS.ws(id)).toBe(`/v1/docs/${id}/ws`)
    expect(PATHS.invite).toBe('/v1/invite')
    expect(PATHS.inviteById('IID')).toBe('/v1/invite/IID')
    expect(PATHS.llm('anthropic')).toBe('/v1/llm/anthropic')
  })
})
