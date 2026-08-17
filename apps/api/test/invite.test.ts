/**
 * §8.13 п.10: второй `GET /invite/{iid}` возвращает 404; по истечении 15 минут — тоже 404.
 */
import { describe, expect, it } from 'vitest'
import { C, PATHS } from '@elementar/proto'
import { handleRequest } from '../src/http/pipeline.js'
import { encodeB32 } from '../src/lib/b32.js'
import {
  HOST,
  makeHarness,
  makeSigner,
  randomBytes,
  randomDocId,
  sigHeader,
} from './helpers/harness.js'
import type { Harness } from './helpers/harness.js'

async function create(h: Harness, iid: string, blob: Uint8Array): Promise<Response> {
  const signer = await makeSigner()
  const body = new TextEncoder().encode(JSON.stringify({ iid, blob: encodeB32(blob) }))
  const header = await sigHeader(signer, {
    method: 'POST',
    path: PATHS.invite,
    docId: iid,
    body,
    tsMs: h.svc.now(),
  })
  const res = await handleRequest(
    new Request(`${HOST}${PATHS.invite}`, {
      method: 'POST',
      headers: { 'x-elm-sig': header },
      body: body as unknown as BodyInit,
    }),
    h.svc,
  )
  await h.settle()
  return res
}

function fetchInvite(h: Harness, iid: string): Promise<Response> {
  return handleRequest(new Request(`${HOST}${PATHS.inviteById(iid)}`), h.svc)
}

describe('приглашения', () => {
  it('одноразовость: второй GET даёт тот же 404', async () => {
    const h = makeHarness()
    const iid = randomDocId()
    const blob = randomBytes(96)

    const created = await create(h, iid, blob)
    expect(created.status).toBe(201)
    const body = (await created.json()) as { iid: string; expiresAt: number }
    expect(body.iid).toBe(iid)
    expect(body.expiresAt).toBe(h.svc.now() + C.INVITE_TTL_MS)

    const first = await fetchInvite(h, iid)
    expect(first.status).toBe(200)
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(blob)

    const second = await fetchInvite(h, iid)
    expect(second.status).toBe(404)
  })

  it('через 15 минут приглашение исчезает', async () => {
    const h = makeHarness()
    const iid = randomDocId()
    expect((await create(h, iid, randomBytes(32))).status).toBe(201)

    h.clock.now += C.INVITE_TTL_MS + 1
    expect((await fetchInvite(h, iid)).status).toBe(404)
  })

  it('кривой iid не доходит до InviteDO', async () => {
    const h = makeHarness()
    const res = await fetchInvite(h, 'not-an-iid')
    expect(res.status).toBe(404)
    expect(h.invites.records.size).toBe(0)
  })

  it('блоб длиннее 128 байт не принимается', async () => {
    const h = makeHarness()
    const res = await create(h, randomDocId(), randomBytes(129))
    expect(res.status).toBe(400)
  })
})
