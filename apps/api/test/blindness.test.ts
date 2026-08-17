/**
 * §8.13 п.11 — тест философии. Сценарий «создать планер, добавить 50 задач», затем проход
 * по всем строкам каталога, по всему хранилищу DO и по всем объектам R2: ни одно поле
 * не содержит ни байта открытого текста. Падать этот тест должен громко.
 */
import { describe, expect, it } from 'vitest'
import { PATHS } from '@elementar/proto'
import { handleRequest } from '../src/http/pipeline.js'
import { encodeB32 } from '../src/lib/b32.js'
import {
  createDoc,
  el1Payload,
  framePacket,
  makeHarness,
  makeSigner,
  makeWrap,
  randomBytes,
  randomDocId,
  signedRequest,
} from './helpers/harness.js'

const TASKS = [
  'Купить молоко',
  'Развод, делим квартиру на Профсоюзной',
  'Записать Соню к стоматологу',
  'Оплатить ипотеку 14 числа',
  'Позвонить маме про анализы',
]

/** Поля каталога D1 — исчерпывающий список; появление нового поля обязано ломать тест. */
const ALLOWED_CATALOG_FIELDS = new Set([
  'docId',
  'sigAlg',
  'sigPub',
  'app',
  'state',
  'seq',
  'snapshotSeq',
  'snapshotGen',
  'snapshotBytes',
  'snapshotLoc',
  'logCount',
  'logBytes',
  'totalBytes',
  'wrapVer',
  'createdAt',
  'updatedAt',
  'lastSeenAt',
  'expiresAt',
  'deletedAt',
  'purgeAfter',
])

function bytesInclude(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || hay.length < needle.length) return false
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

async function aesKey(): Promise<CryptoKey> {
  return (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])) as CryptoKey
}

async function seal(key: CryptoKey, text: string): Promise<Uint8Array> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(text) as BufferSource,
  )
  return el1Payload(new Uint8Array(ct))
}

describe('слепота сервера', () => {
  it('после 50 задач ни один байт открытого текста не лежит на сервере', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    const key = await aesKey()

    const snapshot = await seal(key, JSON.stringify({ title: 'Переезд', tasks: TASKS }))
    expect((await createDoc(h, signer, docId, { snapshot })).status).toBe(201)

    const clientId = randomBytes(8)
    for (let batch = 0; batch < 5; batch++) {
      const payloads: Uint8Array[] = []
      for (let i = 0; i < 10; i++) {
        const text = TASKS[(batch * 10 + i) % TASKS.length] ?? 'задача'
        payloads.push(await seal(key, `${text} #${batch * 10 + i}`))
      }
      const body = framePacket(clientId, batch * 10 + 1, payloads)
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
    }

    const wrapReq = await signedRequest(signer, {
      method: 'PUT',
      path: PATHS.wrap(docId),
      docId,
      body: new TextEncoder().encode(JSON.stringify({ wrap: makeWrap(2) })),
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(wrapReq, h.svc)).status).toBe(200)

    // ── 1. каталог D1: только размеры и сроки, ни одного не-ASCII байта
    const row = h.catalog.docs.get(docId)
    expect(row).toBeDefined()
    for (const field of Object.keys(row ?? {})) {
      expect(ALLOWED_CATALOG_FIELDS.has(field)).toBe(true)
    }
    const catalogDump = JSON.stringify([...h.catalog.docs], (_key, v: unknown) =>
      v instanceof Uint8Array ? encodeB32(v) : v,
    )
    expect(/[^ -~]/.test(catalogDump)).toBe(false)

    // ── 2. хранилище DO и R2: ни одной подстроки открытого текста
    const haystacks: Uint8Array[] = []
    const store = h.docs.store(docId)
    for (const d of store.listDeltas(0, 1000)) haystacks.push(d.payload)
    const snap = store.readSnapshot(1)
    if (snap !== null) haystacks.push(snap)
    for (const obj of h.blobs.objects.values()) haystacks.push(obj.body)
    haystacks.push(new TextEncoder().encode(JSON.stringify(store.dumpAll())))
    haystacks.push(new TextEncoder().encode(catalogDump))
    haystacks.push(new TextEncoder().encode([...h.catalog.metrics.keys()].join(',')))

    expect(haystacks.length).toBeGreaterThan(50)
    for (const text of TASKS) {
      const needle = new TextEncoder().encode(text)
      for (const hay of haystacks) {
        expect(bytesInclude(hay, needle)).toBe(false)
      }
    }

    // ── 3. журнал существует и цел: слепота не означает потерю данных
    expect(store.logStats().count).toBe(50)
    await h.docs.core(docId).flush() // в проде это делает alarm раз в 60 с
    expect(h.catalog.docs.get(docId)?.logCount).toBe(50)
  })

  it('ключи R2 не содержат ничего, кроме docId, поколения и диапазона seq', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    const key = await aesKey()
    await createDoc(h, signer, docId)

    const clientId = randomBytes(8)
    const payloads = [await seal(key, TASKS[0] ?? 'x'), await seal(key, TASKS[1] ?? 'y')]
    const push = await signedRequest(signer, {
      method: 'POST',
      path: PATHS.deltas(docId),
      docId,
      body: framePacket(clientId, 1, payloads),
      tsMs: h.svc.now(),
    })
    await handleRequest(push, h.svc)
    await h.settle()

    // компакция до головы: safeCompactSeq = head, пиров нет
    const big = await seal(key, JSON.stringify(TASKS))
    const put = await signedRequest(signer, {
      method: 'PUT',
      path: PATHS.snapshot(docId),
      docId,
      body: big,
      tsMs: h.svc.now(),
    })
    const req = new Request(put.url, {
      method: 'PUT',
      headers: new Headers([...put.headers, ['x-elm-base-seq', '2']]),
      body: big as unknown as BodyInit,
    })
    const res = await handleRequest(req, h.svc)
    await h.settle()
    expect(res.status).toBe(200)

    for (const k of h.blobs.objects.keys()) {
      expect(k.startsWith(`doc/${docId}/`)).toBe(true)
      expect(/^doc\/[0-9A-HJKMNP-TV-Z]{20}\/(snap\/\d+\.bin|trash\/\d+-\d+\.bin)$/.test(k)).toBe(
        true,
      )
    }
  })
})
