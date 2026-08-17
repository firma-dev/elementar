import { describe, expect, it } from 'vitest'
import {
  C,
  PATHS,
  SIG_HEADER,
  SIG_PUB_BYTES,
  canonicalSigInput,
  parseSigHeader,
  parseWsSubprotocols,
} from '@elementar/proto'
import {
  createSigner,
  preferredSigAlg,
  signRequest,
  signWsHandshake,
  verifyRequest,
  verifySignature,
  wsSubprotocols,
} from '../../src/crypto/sign.js'
import { deriveSignSeed } from '../../src/crypto/keys.js'
import { b32decodeExact, b32encode } from '../../src/crypto/b32.js'

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

const LINK_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i)
const DOC_ID_BYTES = Uint8Array.from({ length: 12 }, (_, i) => 0xf0 - i)
const DOC_ID = 'Y3QYXVFCXFNEKT77WVJG'
const TS = 1_700_000_000_000
const SIG_NONCE = Uint8Array.from({ length: 12 }, (_, i) => i + 100)

/** Замороженные векторы подписи: ключ и Ed25519-подпись детерминированы. */
const V = {
  signSeed: 'd27b56d5ecede8a8b1b41a1d05aa18617486f1bd83f91d567b8f1187bfe8e89f',
  edPub: '8a4b8d7f8822c307800c8cc2e8613ef76749373bbf3f9557b9d2676876f8d0a2',
  p256Pub:
    '047658a8be10ba93163e6328b7263d79969229682936ad594601cb2a2e9084939eebaff13b350e40efeeb1c1ff259ec45101f7ac003d662634077cb5026f3fc54e',
  canon:
    '454c31570103474554001d2f76312f646f63732f593351595856464358464e454b54373757564a47f0efeeedecebeae9e8e7e6e50000018bcfe568006465666768696a6b6c6d6e6fe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  edSig:
    'c4d62e925e867849334fccfbe65c6f056d1fe1b83b60bebdd2d45b9a178e4fb618b3f97f86523acd2b23ac8c814178bc0cd447794ee2b7364fa9e27e77e7190c',
} as const

const emptySha256 = async (): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(0)))

describe('подпись запросов', () => {
  it('замороженные векторы ключа и подписи Ed25519', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    expect(hex(seed)).toBe(V.signSeed)
    const signer = await createSigner(seed, 'ed25519')
    expect(hex(signer.publicKey)).toBe(V.edPub)
    expect(signer.publicKey).toHaveLength(SIG_PUB_BYTES.ed25519)

    const input = canonicalSigInput({
      method: 'GET',
      path: PATHS.doc(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
      tsMs: TS,
      sigNonce: SIG_NONCE,
      bodySha256: await emptySha256(),
    })
    expect(hex(input)).toBe(V.canon)
    expect(hex(await signer.sign(input))).toBe(V.edSig)
    expect(
      await verifySignature('ed25519', signer.publicKey, input, await signer.sign(input)),
    ).toBe(true)
  })

  it('ключ P-256 детерминирован из того же signSeed', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'p256')
    expect(hex(signer.publicKey)).toBe(V.p256Pub)
    expect(signer.publicKey).toHaveLength(SIG_PUB_BYTES.p256)
    const again = await createSigner(seed, 'p256')
    expect(hex(again.publicKey)).toBe(hex(signer.publicKey))
  })

  it('обязательный фолбэк P-256 подписывает и проверяется', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'p256')
    const msg = new TextEncoder().encode('фолбэк обязателен и протестирован')
    const sig = await signer.sign(msg)
    expect(sig).toHaveLength(64)
    expect(await verifySignature('p256', signer.publicKey, msg, sig)).toBe(true)
    const broken = sig.slice()
    broken[0] = (broken[0] as number) ^ 0xff
    expect(await verifySignature('p256', signer.publicKey, msg, broken)).toBe(false)
  })

  it('алгоритм по умолчанию — ed25519', () => {
    expect(preferredSigAlg()).toBe('ed25519')
  })

  for (const alg of ['ed25519', 'p256'] as const) {
    it(`полный цикл подписи и проверки запроса (${alg})`, async () => {
      const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
      const signer = await createSigner(seed, alg)
      const body = new TextEncoder().encode('{"hello":"world"}')
      const signed = await signRequest(signer, {
        method: 'POST',
        path: PATHS.deltas(DOC_ID),
        docIdBytes: DOC_ID_BYTES,
        body,
        tsMs: TS,
        sigNonce: SIG_NONCE,
      })
      expect(signed.header.startsWith(`v1,${alg},${TS},`)).toBe(true)
      const parsed = parseSigHeader(signed.header)
      expect(parsed).not.toBeNull()
      expect([...b32decodeExact((parsed as { sigNonceB32: string }).sigNonceB32, 12)]).toEqual([
        ...SIG_NONCE,
      ])

      const base = {
        header: signed.header,
        method: 'POST',
        path: PATHS.deltas(DOC_ID),
        docIdBytes: DOC_ID_BYTES,
        bodySha256: signed.bodySha256,
        sigAlg: alg,
        sigPub: signer.publicKey,
        nowMs: TS + 1000,
      }
      expect((await verifyRequest(base)).ok).toBe(true)

      // подпись GET не переигрывается как DELETE: метод входит в канонизацию
      expect(await verifyRequest({ ...base, method: 'DELETE' })).toMatchObject({
        ok: false,
        code: 'ELM_SIG_INVALID',
      })
      // и не переносится на другой путь
      expect(await verifyRequest({ ...base, path: PATHS.snapshot(DOC_ID) })).toMatchObject({
        ok: false,
        code: 'ELM_SIG_INVALID',
      })
      // и не переносится на другой документ
      expect(
        await verifyRequest({ ...base, docIdBytes: Uint8Array.from({ length: 12 }, () => 7) }),
      ).toMatchObject({ ok: false, code: 'ELM_SIG_INVALID' })
      // подмена тела ломает подпись
      expect(await verifyRequest({ ...base, bodySha256: await emptySha256() })).toMatchObject({
        ok: false,
        code: 'ELM_SIG_INVALID',
      })
    })
  }

  it('окно свежести ±120 с', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'ed25519')
    const signed = await signRequest(signer, {
      method: 'GET',
      path: PATHS.doc(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
      tsMs: TS,
      sigNonce: SIG_NONCE,
    })
    const base = {
      header: signed.header,
      method: 'GET',
      path: PATHS.doc(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
      bodySha256: signed.bodySha256,
      sigAlg: 'ed25519' as const,
      sigPub: signer.publicKey,
    }
    expect((await verifyRequest({ ...base, nowMs: TS + C.SIG_SKEW_MS })).ok).toBe(true)
    expect(await verifyRequest({ ...base, nowMs: TS + C.SIG_SKEW_MS + 1 })).toMatchObject({
      code: 'ELM_SIG_EXPIRED',
    })
    expect(await verifyRequest({ ...base, nowMs: TS - C.SIG_SKEW_MS - 1 })).toMatchObject({
      code: 'ELM_SIG_EXPIRED',
    })
  })

  it('отсутствующий и мусорный заголовок отличаются от неверной подписи', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'ed25519')
    const base = {
      method: 'GET',
      path: PATHS.doc(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
      bodySha256: await emptySha256(),
      sigAlg: 'ed25519' as const,
      sigPub: signer.publicKey,
      nowMs: TS,
    }
    expect(await verifyRequest({ ...base, header: null })).toMatchObject({
      code: 'ELM_SIG_MISSING',
    })
    expect(await verifyRequest({ ...base, header: 'v1,ed25519,мусор' })).toMatchObject({
      code: 'ELM_SIG_MISSING',
    })
    const wrongAlg = await signRequest(await createSigner(seed, 'p256'), {
      method: 'GET',
      path: PATHS.doc(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
      tsMs: TS,
      sigNonce: SIG_NONCE,
    })
    expect(await verifyRequest({ ...base, header: wrongAlg.header })).toMatchObject({
      code: 'ELM_SIG_INVALID',
    })
  })

  it('имя заголовка и формат — из proto', async () => {
    expect(SIG_HEADER).toBe('x-elm-sig')
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'ed25519')
    const signed = await signRequest(signer, {
      method: 'GET',
      path: PATHS.doc(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
    })
    expect(signed.header.split(',')).toHaveLength(5)
    expect(Math.abs(signed.tsMs - Date.now())).toBeLessThan(5000)
    expect(signed.sigNonce).toHaveLength(C.SIG_NONCE_BYTES)
  })

  it('WS-хендшейк подписывает GET /v1/docs/{id}/ws с пустым телом', async () => {
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'ed25519')
    const clientId = Uint8Array.from({ length: 8 }, (_, i) => i + 1)
    const h = await signWsHandshake(signer, {
      docId: DOC_ID,
      docIdBytes: DOC_ID_BYTES,
      since: 42,
      clientId,
      tsMs: TS,
      sigNonce: SIG_NONCE,
    })
    expect(h.since).toBe(42)
    expect(h.clientIdB32).toBe(b32encode(clientId))
    const tokens = wsSubprotocols(h)
    expect(tokens[0]).toBe('elm.v1')
    const reparsed = parseWsSubprotocols(tokens)
    expect(reparsed).toEqual(h)

    const verified = await verifyRequest({
      header: `v1,${h.sig.alg},${h.sig.tsMs},${h.sig.sigNonceB32},${h.sig.sigB32}`,
      method: 'GET',
      path: PATHS.ws(DOC_ID),
      docIdBytes: DOC_ID_BYTES,
      bodySha256: await emptySha256(),
      sigAlg: 'ed25519',
      sigPub: signer.publicKey,
      nowMs: TS,
    })
    expect(verified.ok).toBe(true)
  })

  it('кривые входы отвергаются', async () => {
    await expect(createSigner(new Uint8Array(31), 'ed25519')).rejects.toMatchObject({
      reason: 'bad-seed',
    })
    const seed = await deriveSignSeed(LINK_SECRET, DOC_ID_BYTES)
    const signer = await createSigner(seed, 'ed25519')
    expect(
      await verifySignature('ed25519', new Uint8Array(31), new Uint8Array(4), new Uint8Array(64)),
    ).toBe(false)
    expect(
      await verifySignature('ed25519', signer.publicKey, new Uint8Array(4), new Uint8Array(10)),
    ).toBe(false)
  })
})
