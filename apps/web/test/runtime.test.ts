import { afterEach, describe, expect, it } from 'vitest'
import { isDocId, isFragment } from '@elementar/proto'
import { buildFragment, tryParseLink } from '@elementar/core'
import { PLANER, listBucket } from '../src/corpus/planer/schema.js'
import type { PlanerCollections } from '../src/corpus/planer/schema.js'
import { addTask } from '../src/corpus/planer/actions.js'
import { createDocument, openDocument, repo } from '../src/runtime/index.js'
import type { DocHandle } from '../src/runtime/index.js'
import { parseRoute } from '../src/routes.js'

const open: Array<DocHandle<PlanerCollections>> = []

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

async function fresh(): Promise<DocHandle<PlanerCollections>> {
  const handle = await createDocument<PlanerCollections>(PLANER, {
    title: 'Наш планер',
    sync: false,
  })
  open.push(handle)
  return handle
}

describe('рантайм документа', () => {
  it('создаёт документ, ключи и карточку — без сети', async () => {
    const handle = await fresh()
    expect(isDocId(handle.id)).toBe(true)
    expect(handle.corpus).toBe('planer')
    expect(handle.sync).toBe(false)
    expect(handle.hasPassword).toBe(false)

    const parsed = tryParseLink(handle.link)
    expect(parsed).not.toBeNull()
    expect(parsed?.docId).toBe(handle.id)
    expect(isFragment(buildFragment(handle.keys.linkSecret))).toBe(true)

    const r = await repo()
    const card = await r.getDoc(handle.id)
    expect(card?.corpus).toBe('planer')
    const secrets = await r.getSecrets(handle.id)
    expect(secrets?.mode).toBe('plain')
    expect(secrets?.wrap.wrapVer).toBe(1)
    expect(secrets?.linkSecret).toBeDefined()
  })

  it('задачи переживают закрытие и повторное открытие (офлайн)', async () => {
    const handle = await fresh()
    addTask(handle, { title: 'купить коробки', bucket: listBucket('home'), date: '2026-08-20' })
    await handle.session.snapshot()
    const id = handle.id
    await handle.close()
    open.length = 0

    const again = await openDocument<PlanerCollections>(PLANER, id)
    open.push(again)
    const tasks = again.col.task.all.value
    expect(tasks.map((t) => t.title)).toEqual(['купить коробки'])
    expect(tasks[0]?.bucket).toBe(listBucket('home'))
    expect(again.title.value).toBe('Наш планер')
  })

  it('без ключа документ не открывается', async () => {
    const handle = await fresh()
    const id = handle.id
    await handle.close()
    open.length = 0
    const r = await repo()
    await r.forgetLinkSecret(id)

    await expect(openDocument(PLANER, id)).rejects.toMatchObject({ reason: 'need-link' })
  })

  it('ссылка с фрагментом открывает документ на «чистом» устройстве', async () => {
    const handle = await fresh()
    const link = handle.link
    const id = handle.id
    addTask(handle, { title: 'из ссылки', bucket: listBucket('work') })
    await handle.session.snapshot()
    await handle.close()
    open.length = 0

    const r = await repo()
    await r.forgetLinkSecret(id)
    const again = await openDocument<PlanerCollections>(PLANER, link, { sync: false })
    open.push(again)
    expect(again.col.task.all.value.map((t) => t.title)).toEqual(['из ссылки'])
  })
})

describe('маршруты', () => {
  it('корень — прихожая, /p/<id> — планер, фрагмент подхватывается', () => {
    expect(parseRoute(new URL('https://elementar.example/')).kind).toBe('hall')
    const fragment = 'A'.repeat(53)
    const route = parseRoute(new URL(`https://elementar.example/p/${'K'.repeat(20)}#${fragment}`))
    expect(route.kind).toBe('doc')
    if (route.kind !== 'doc') return
    expect(route.corpus).toBe('planer')
    expect(route.docId).toBe('K'.repeat(20))
    expect(route.fragment).toBe(fragment)
  })

  it('финансер и приглашение — свои маршруты, мусор — «не найдено»', () => {
    const f = parseRoute(new URL(`https://elementar.example/f/${'K'.repeat(20)}`))
    expect(f.kind === 'doc' && f.corpus === 'finanser').toBe(true)
    expect(parseRoute(new URL('https://elementar.example/i/ABCD')).kind).toBe('invite')
    expect(parseRoute(new URL('https://elementar.example/share?url=x')).kind).toBe('share')
    expect(parseRoute(new URL('https://elementar.example/p/короткий')).kind).toBe('notFound')
  })

  it('ярлык /p/last распознаётся как документ-псевдоним', () => {
    const route = parseRoute(new URL('https://elementar.example/p/last?new=1'))
    expect(route.kind === 'doc' && route.docId === 'last').toBe(true)
  })
})
