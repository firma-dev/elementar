/**
 * §8.13 п.4, 5, 8: идемпотентность (clientId, clientSeq), догон дельтами, отставание
 * за снапшот → resync, заливка до 507 и разблокировка снапшотом.
 */
import { describe, expect, it } from 'vitest'
import { C, HDR, PATHS, decodeFrames } from '@elementar/proto'
import type { DocId, PushResult } from '@elementar/proto'
import { handleRequest } from '../src/http/pipeline.js'
import { encodeB32 } from '../src/lib/b32.js'
import {
  HOST,
  createDoc,
  el1Payload,
  framePacket,
  makeHarness,
  makeSigner,
  randomBytes,
  randomDocId,
  signedRequest,
} from './helpers/harness.js'
import type { Harness, Signer } from './helpers/harness.js'

async function pushBatch(
  h: Harness,
  signer: Signer,
  docId: DocId,
  clientId: Uint8Array,
  from: number,
  n: number,
): Promise<Response> {
  const payloads = Array.from({ length: n }, () => el1Payload(randomBytes(16)))
  const req = await signedRequest(signer, {
    method: 'POST',
    path: PATHS.deltas(docId),
    docId,
    body: framePacket(clientId, from, payloads),
    tsMs: h.svc.now(),
  })
  const res = await handleRequest(req, h.svc)
  await h.settle()
  return res
}

async function getDeltas(
  h: Harness,
  signer: Signer,
  docId: DocId,
  since: number,
  clientId?: Uint8Array,
): Promise<Response> {
  const path = `${PATHS.deltas(docId)}`
  const sig = await signedRequest(signer, { method: 'GET', path, docId, tsMs: h.svc.now() })
  const headers = new Headers(sig.headers)
  if (clientId !== undefined) headers.set(HDR.CLIENT, encodeB32(clientId))
  const res = await handleRequest(
    new Request(`${HOST}${path}?since=${since}&limit=256`, { method: 'GET', headers }),
    h.svc,
  )
  await h.settle()
  return res
}

describe('синхронизация', () => {
  it('повтор (clientId, clientSeq) даёт duplicates и тот же seq', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const clientId = randomBytes(8)

    const payload = el1Payload(randomBytes(24))
    const body = framePacket(clientId, 7, [payload])

    const send = async (): Promise<PushResult> => {
      const req = await signedRequest(signer, {
        method: 'POST',
        path: PATHS.deltas(docId),
        docId,
        body,
        tsMs: h.svc.now(),
      })
      const res = await handleRequest(req, h.svc)
      await h.settle()
      expect(res.status).toBe(200)
      return (await res.json()) as PushResult
    }

    const first = await send()
    expect(first.accepted).toBe(1)
    expect(first.duplicates).toBe(0)
    const second = await send()
    expect(second.accepted).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(second.assigned[0]?.seq).toBe(first.assigned[0]?.seq)
    expect(h.docs.store(docId).logStats().count).toBe(1)
  })

  it('отставание на 200 дельт догоняется, отставание за снапшот даёт resync', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const writer = randomBytes(8)
    const reader = randomBytes(8)

    expect((await pushBatch(h, signer, docId, writer, 1, 200)).status).toBe(200)

    const res = await getDeltas(h, signer, docId, 0, reader)
    expect(res.status).toBe(200)
    expect(res.headers.get(HDR.HEAD)).toBe('200')
    const decoded = decodeFrames(new Uint8Array(await res.arrayBuffer()))
    expect(decoded.ok && decoded.frames.length).toBe(200)

    // компакция до 200, дальше отставший клиент за снапшотом
    const snapshot = el1Payload(randomBytes(2048))
    const put = await signedRequest(signer, {
      method: 'PUT',
      path: PATHS.snapshot(docId),
      docId,
      body: snapshot,
      tsMs: h.svc.now(),
    })
    const putRes = await handleRequest(
      new Request(put.url, {
        method: 'PUT',
        headers: new Headers([...put.headers, [HDR.BASE_SEQ, '200']]),
        body: snapshot as unknown as BodyInit,
      }),
      h.svc,
    )
    await h.settle()
    expect(putRes.status).toBe(200)

    const behind = await getDeltas(h, signer, docId, 0, reader)
    expect(behind.status).toBe(409)
    const body = (await behind.json()) as { error: { code: string }; resyncFrom: number }
    expect(body.error.code).toBe('ELM_STALE_BASE')
    expect(body.resyncFrom).toBe(200)
  })

  it('лог упирается в потолок 507, чтение живёт, снапшот разблокирует', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const clientId = randomBytes(8)

    let seq = 1
    for (let i = 0; i < C.LOG_CEIL_COUNT / 250; i++) {
      expect((await pushBatch(h, signer, docId, clientId, seq, 250)).status).toBe(200)
      seq += 250
    }
    expect(h.docs.store(docId).logStats().count).toBe(C.LOG_CEIL_COUNT)

    const overflow = await pushBatch(h, signer, docId, clientId, seq, 1)
    expect(overflow.status).toBe(507)
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe(
      'ELM_QUOTA_LOG_FULL',
    )

    // чтение продолжает работать; читатель подтвердил приём до 256-й дельты
    expect((await getDeltas(h, signer, docId, 0, clientId)).status).toBe(200)

    const putSnapshot = async (baseSeq: number): Promise<Response> => {
      const snapshot = el1Payload(randomBytes(1024))
      const put = await signedRequest(signer, {
        method: 'PUT',
        path: PATHS.snapshot(docId),
        docId,
        body: snapshot,
        tsMs: h.svc.now(),
      })
      const res = await handleRequest(
        new Request(put.url, {
          method: 'PUT',
          headers: new Headers([...put.headers, [HDR.BASE_SEQ, String(baseSeq)]]),
          body: snapshot as unknown as BodyInit,
        }),
        h.svc,
      )
      await h.settle()
      return res
    }

    // компакция до головы небезопасна: партнёр подтвердил только 256 (§8.9)
    const unsafe = await putSnapshot(C.LOG_CEIL_COUNT)
    expect(unsafe.status).toBe(409)
    const unsafeBody = (await unsafe.json()) as { error: { code: string }; safeCompactSeq: number }
    expect(unsafeBody.error.code).toBe('ELM_UNSAFE_BASE')
    expect(unsafeBody.safeCompactSeq).toBe(256)

    const safe = await putSnapshot(unsafeBody.safeCompactSeq)
    expect(safe.status).toBe(200)
    expect(h.docs.store(docId).logStats().count).toBe(C.LOG_CEIL_COUNT - 256)

    expect((await pushBatch(h, signer, docId, clientId, seq, 1)).status).toBe(200)
  })

  it('идемпотентность создания: тот же ключ → 200, чужой ключ → 409', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const other = await makeSigner()
    const docId = randomDocId()

    expect((await createDoc(h, signer, docId)).status).toBe(201)
    expect((await createDoc(h, signer, docId)).status).toBe(200)

    const conflict = await createDoc(h, other, docId)
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('ELM_EXISTS')
  })

  it('битый кадр отбивается как ELM_BAD_FRAME, не как краш', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const broken = new Uint8Array([0xe1, 0x01, 0x02, 0x00, 0x00])
    const req = await signedRequest(signer, {
      method: 'POST',
      path: PATHS.deltas(docId),
      docId,
      body: broken,
      tsMs: h.svc.now(),
    })
    const res = await handleRequest(req, h.svc)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ELM_BAD_FRAME')
  })

  it('wrapVer обязан расти', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const put = async (ver: number): Promise<Response> => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          wrap: {
            v: 1,
            wrapVer: ver,
            kdf: { alg: 'none' },
            nonce: encodeB32(randomBytes(C.NONCE_BYTES)),
            ct: encodeB32(randomBytes(48)),
          },
        }),
      )
      const req = await signedRequest(signer, {
        method: 'PUT',
        path: PATHS.wrap(docId),
        docId,
        body,
        tsMs: h.svc.now(),
      })
      const res = await handleRequest(req, h.svc)
      await h.settle()
      return res
    }

    expect((await put(2)).status).toBe(200)
    const stale = await put(2)
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('ELM_WRAP_STALE')
  })
})
