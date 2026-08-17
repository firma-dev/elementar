import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  C,
  CanonError,
  PATHS,
  PROTOCOL_VERSION,
  canonicalSigInput,
  formatSigHeader,
  isTimestampFresh,
  parseSigHeader,
  safeCanonicalSigInput,
} from '../src/index.js'

const DOC_ID = 'K7M4Q8XB2NJ0PRTV5W3Z'
const docIdBytes = new Uint8Array(12).fill(0xab)
const sigNonce = new Uint8Array(12).fill(0x11)
const bodySha256 = new Uint8Array(32).fill(0x22)
const tsMs = 1_700_000_000_123

function base(method: string, path: string) {
  return { method, path, docIdBytes, tsMs, sigNonce, bodySha256 }
}

/** Независимая сборка той же раскладки — если она разъедется с кодом, тест упадёт. */
function reference(method: string, path: string): Uint8Array {
  const m = new TextEncoder().encode(method)
  const p = new TextEncoder().encode(path)
  const out: number[] = []
  out.push(0x45, 0x4c, 0x31, 0x57) // "EL1W"
  out.push(PROTOCOL_VERSION)
  out.push(m.length)
  out.push(...m)
  out.push((p.length >>> 8) & 0xff, p.length & 0xff) // u16be
  out.push(...p)
  out.push(...docIdBytes)
  const ts = BigInt(tsMs)
  for (let i = 7; i >= 0; i--) out.push(Number((ts >> BigInt(i * 8)) & 0xffn)) // u64be
  out.push(...sigNonce)
  out.push(...bodySha256)
  return new Uint8Array(out)
}

describe('канонизация подписи (§4.5)', () => {
  it('байты совпадают с независимой сборкой раскладки', () => {
    const path = PATHS.deltas(DOC_ID)
    expect(canonicalSigInput(base('GET', path))).toEqual(reference('GET', path))
  })

  it('длина = 4+1+1+len(method)+2+len(path)+12+8+12+32', () => {
    const path = PATHS.doc(DOC_ID)
    const out = canonicalSigInput(base('DELETE', path))
    expect(out.length).toBe(4 + 1 + 1 + 6 + 2 + path.length + 12 + 8 + 12 + 32)
  })

  it('регистр метода нормализуется вверх', () => {
    const path = PATHS.doc(DOC_ID)
    expect(canonicalSigInput(base('get', path))).toEqual(canonicalSigInput(base('GET', path)))
  })

  it('ГЛАВНОЕ: подпись GET /ws нельзя переиграть как DELETE документа', () => {
    const ws = canonicalSigInput(base('GET', PATHS.ws(DOC_ID)))
    const del = canonicalSigInput(base('DELETE', PATHS.doc(DOC_ID)))
    expect(ws).not.toEqual(del)
    // отличие начинается уже в поле метода, а не где-то в хвосте
    expect(ws[5]).toBe(3)
    expect(del[5]).toBe(6)
  })

  it('смена только метода при том же пути меняет вход подписи', () => {
    const path = PATHS.doc(DOC_ID)
    for (const [a, b] of [
      ['GET', 'DELETE'],
      ['POST', 'PUT'],
      ['GET', 'POST'],
    ] as const) {
      expect(canonicalSigInput(base(a, path))).not.toEqual(canonicalSigInput(base(b, path)))
    }
  })

  it('смена только пути меняет вход подписи', () => {
    const g = canonicalSigInput(base('GET', PATHS.doc(DOC_ID)))
    const s = canonicalSigInput(base('GET', PATHS.snapshot(DOC_ID)))
    expect(g).not.toEqual(s)
  })

  it('префикс длины пути не даёт склеить границу метод/путь', () => {
    // '/aa' + 'b' против '/aab' + '' — длины разные, значит и байты разные
    const x = canonicalSigInput(base('GET', '/v1/docs/AA/deltas'))
    const y = canonicalSigInput(base('GET', '/v1/docs/AA/delta'))
    expect(x).not.toEqual(y)
    expect(x.length).not.toBe(y.length)
  })

  it('разные ts, nonce, тело → разные входы', () => {
    const path = PATHS.doc(DOC_ID)
    const a = canonicalSigInput(base('GET', path))
    expect(canonicalSigInput({ ...base('GET', path), tsMs: tsMs + 1 })).not.toEqual(a)
    expect(
      canonicalSigInput({ ...base('GET', path), sigNonce: new Uint8Array(12).fill(0x12) }),
    ).not.toEqual(a)
    expect(
      canonicalSigInput({ ...base('GET', path), bodySha256: new Uint8Array(32).fill(0x23) }),
    ).not.toEqual(a)
  })

  it('невалидный вход — CanonError, а не тихие байты', () => {
    const path = PATHS.doc(DOC_ID)
    expect(() => canonicalSigInput(base('PATCH', path))).toThrow(CanonError)
    expect(() => canonicalSigInput(base('GET', 'v1/docs'))).toThrow(CanonError)
    expect(() => canonicalSigInput(base('GET', `${path}?since=1`))).toThrow(CanonError)
    expect(() => canonicalSigInput(base('GET', `${path}#frag`))).toThrow(CanonError)
    expect(() => canonicalSigInput({ ...base('GET', path), docIdBytes: new Uint8Array(11) })).toThrow(
      CanonError,
    )
    expect(() => canonicalSigInput({ ...base('GET', path), sigNonce: new Uint8Array(8) })).toThrow(
      CanonError,
    )
    expect(() => canonicalSigInput({ ...base('GET', path), bodySha256: new Uint8Array(31) })).toThrow(
      CanonError,
    )
    expect(() => canonicalSigInput({ ...base('GET', path), tsMs: -1 })).toThrow(CanonError)
    expect(() => canonicalSigInput({ ...base('GET', path), tsMs: 1.5 })).toThrow(CanonError)
  })

  it('safeCanonicalSigInput не бросает никогда', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (method, path) => {
        expect(() => safeCanonicalSigInput({ ...base(method, path) })).not.toThrow()
      }),
      { numRuns: 300 },
    )
    expect(safeCanonicalSigInput(base('GET', 'нет-слеша'))).toBeNull()
    expect(safeCanonicalSigInput(base('GET', PATHS.doc(DOC_ID)))).not.toBeNull()
  })
})

describe('заголовок X-Elm-Sig', () => {
  const h = { alg: 'ed25519' as const, tsMs, sigNonceB32: '0'.repeat(20), sigB32: 'A'.repeat(103) }

  it('round-trip', () => {
    expect(parseSigHeader(formatSigHeader(h))).toEqual(h)
  })

  it('мусор даёт null, а не исключение', () => {
    const bads = [
      '',
      'v2,ed25519,1,00000000000000000000,AAAA',
      'v1,rsa,1,00000000000000000000,AAAA',
      'v1,ed25519,x,00000000000000000000,AAAA',
      'v1,ed25519,1,SHORT,AAAA',
      'v1,ed25519,1,0000000000000000000U,AAAA',
      'v1,ed25519,1,00000000000000000000',
      'v1,ed25519,1,00000000000000000000,AAAA,extra',
    ]
    for (const b of bads) expect(parseSigHeader(b)).toBeNull()
    expect(parseSigHeader(null)).toBeNull()
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseSigHeader(s)).not.toThrow()
      }),
      { numRuns: 300 },
    )
  })

  it('окно свежести — ровно SIG_SKEW_MS', () => {
    const now = tsMs
    expect(isTimestampFresh(now - C.SIG_SKEW_MS, now)).toBe(true)
    expect(isTimestampFresh(now + C.SIG_SKEW_MS, now)).toBe(true)
    expect(isTimestampFresh(now - C.SIG_SKEW_MS - 1, now)).toBe(false)
    expect(isTimestampFresh(now + C.SIG_SKEW_MS + 1, now)).toBe(false)
  })
})
