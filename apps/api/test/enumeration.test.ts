/**
 * §9.6: перебор docId. Единый 404 без оракула, штраф только из miss-бакета, ноль
 * инстанцирований DocDO для неизвестных id, нижняя граница времени ответа.
 */
import { describe, expect, it } from 'vitest'
import { C, NOT_FOUND_BODY, PATHS } from '@elementar/proto'
import { handleRequest } from '../src/http/pipeline.js'
import { challengePrefix, dailyPepper, dayKey, prefixHash } from '../src/lib/ipHash.js'
import {
  HOST,
  createDoc,
  makeHarness,
  makeSigner,
  randomDocId,
  signedRequest,
} from './helpers/harness.js'
import type { Harness } from './helpers/harness.js'

async function prefixOf(h: Harness): Promise<string> {
  const pepper = await dailyPepper(h.svc.pepper, dayKey(h.svc.now()))
  return prefixHash(pepper, challengePrefix(''))
}

async function hitUnknown(h: Harness): Promise<Response> {
  const res = await handleRequest(
    new Request(`${HOST}${PATHS.doc(randomDocId())}`, {
      headers: { 'x-elm-sig': 'v1,ed25519,1,X,Y' },
    }),
    h.svc,
  )
  await h.settle()
  return res
}

describe('перебор и единый 404', () => {
  it('перебор упирается в 403 ELM_CHALLENGE, а не в 429 и не в блок', async () => {
    const h = makeHarness()
    const statuses: number[] = []
    for (let i = 0; i < 25; i++) statuses.push((await hitUnknown(h)).status)

    expect(statuses.slice(0, 3)).toEqual([404, 404, 404])
    expect(statuses).toContain(403)
    expect(statuses).not.toContain(429)
    const state = h.limiter.core.state(await prefixOf(h))
    expect(state.blockedUntil).toBe(0)
    expect(state.challengeUntil).toBeGreaterThan(h.svc.now())
  })

  it('запрос с валидной подписью проходит при пустом miss-бакете', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    expect((await createDoc(h, signer, docId)).status).toBe(201)

    for (let i = 0; i < 10; i++) await hitUnknown(h)
    expect(h.limiter.core.state(await prefixOf(h)).miss.tokens).toBe(0)

    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    const res = await handleRequest(req, h.svc)
    expect(res.status).toBe(200)
  })

  it('успешный аутентифицированный ответ снижает missStreak', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    await hitUnknown(h)
    await hitUnknown(h)
    const prefix = await prefixOf(h)
    expect(h.limiter.core.state(prefix).missStreak).toBe(2)

    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(req, h.svc)).status).toBe(200)
    await h.settle()
    expect(h.limiter.core.state(prefix).missStreak).toBe(1)
  })

  it('1000 запросов к несуществующим id не создают ни одного DocDO', async () => {
    const h = makeHarness()
    for (let i = 0; i < 1000; i++) await hitUnknown(h)
    expect(h.docs.instantiations).toBe(0)
  })

  it('кривой формат docId отвечает тем же 404 и не ходит никуда', async () => {
    const bad = ['SHORT', 'ABCDEFGHIJKLMNOPQRSTU', 'abcdefghjkmnpqrstvwx', '../../etc/passwd']
    for (const raw of bad) {
      // свежий префикс на каждый id: иначе на четвёртом промахе прилетит челлендж
      const h = makeHarness()
      const res = await handleRequest(
        new Request(`${HOST}/v1/docs/${encodeURIComponent(raw)}`),
        h.svc,
      )
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(NOT_FOUND_BODY)
      expect(h.docs.instantiations).toBe(0)
      expect(h.catalog.docs.size).toBe(0)
    }
  })

  it('ответы «нет документа» и «подпись неверна» побайтово одинаковы', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const stranger = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const badSig = await signedRequest(stranger, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    const a = await handleRequest(badSig, h.svc)

    const missing = randomDocId()
    const noDoc = await signedRequest(stranger, {
      method: 'GET',
      path: PATHS.doc(missing),
      docId: missing,
      tsMs: h.svc.now(),
    })
    const b = await handleRequest(noDoc, h.svc)

    expect(a.status).toBe(b.status)
    expect(await a.text()).toBe(await b.text())
    const ha = [...a.headers].sort()
    const hb = [...b.headers].sort()
    expect(ha).toEqual(hb)
  })

  it('время ответа 404 не меньше ELM_404_MIN_MS и не различает ветки', async () => {
    const measure = async (kind: 'missing' | 'badsig'): Promise<number> => {
      const h = makeHarness({ realClock: true })
      const signer = await makeSigner()
      const stranger = await makeSigner()
      const docId = randomDocId()
      if (kind === 'badsig') await createDoc(h, signer, docId)
      const req = await signedRequest(stranger, {
        method: 'GET',
        path: PATHS.doc(docId),
        docId,
        tsMs: h.svc.now(),
      })
      const t0 = Date.now()
      const res = await handleRequest(req, h.svc)
      const dt = Date.now() - t0
      expect(res.status).toBe(404)
      return dt
    }

    const missing: number[] = []
    const badsig: number[] = []
    for (let i = 0; i < 5; i++) {
      missing.push(await measure('missing'))
      badsig.push(await measure('badsig'))
    }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    expect(median(missing)).toBeGreaterThanOrEqual(C.MIN_404_MS - 1)
    expect(median(badsig)).toBeGreaterThanOrEqual(C.MIN_404_MS - 1)
    expect(Math.abs(median(missing) - median(badsig))).toBeLessThanOrEqual(5)
  })

  it('зеркало блокировок не живёт дольше 48 часов', async () => {
    const h = makeHarness()
    const now = h.svc.now()
    await h.catalog.recordBlock(new Uint8Array(16), 1, now + C.BLOCK_MAX_MS, now)
    for (const v of h.catalog.blocks.values()) {
      expect(v.expiresAt).toBeLessThanOrEqual(now + 48 * 3_600_000)
    }
    h.clock.now += 49 * 3_600_000
    await h.catalog.cleanupBlocks(h.svc.now())
    expect(h.catalog.blocks.size).toBe(0)
  })
})
