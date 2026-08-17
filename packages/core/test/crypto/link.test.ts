import { describe, expect, it } from 'vitest'
import {
  APP_PREFIX,
  C,
  ORIGIN,
  SIZES,
  groupForDisplay,
  isDocId,
  isFragment,
} from '@elementar/proto'
import {
  INVITE_BLOB_BYTES,
  LinkError,
  buildFragment,
  buildLink,
  consumeLinkFromLocation,
  createDocumentKeys,
  createInviteMaterial,
  documentKeysFrom,
  exportRecovery,
  importRecovery,
  inviteIdFromSecret,
  openInviteBlob,
  parseFragment,
  parseInviteUrl,
  parseLink,
  sealAddressBar,
  tryParseLink,
} from '../../src/crypto/link.js'
import { timingSafeEqual } from '../../src/crypto/keys.js'
import { b32encode } from '../../src/crypto/b32.js'

const LINK_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i)
const DOC_ID = 'Y3QYXVFCXFNEKT77WVJG'
const FRAGMENT = '040020G30G2GC1R81450P30D1R7H048J2CA1A5GQ30CHM6RW3MF1Y'

describe('постоянная ссылка', () => {
  it('замороженный вид ссылки и фрагмента', () => {
    const keys = documentKeysFrom(DOC_ID, LINK_SECRET)
    expect(buildFragment(LINK_SECRET)).toBe(FRAGMENT)
    expect(isFragment(FRAGMENT)).toBe(true)
    expect(FRAGMENT).toHaveLength(SIZES.FRAGMENT_CHARS)
    const link = buildLink(ORIGIN, keys)
    expect(link).toBe(`${ORIGIN}${APP_PREFIX.planer}/${DOC_ID}#${FRAGMENT}`)
    // 98 ASCII-байт при боевом домене; на заглушке — тот же порядок
    expect(link.split('#')[1]).toHaveLength(53)
  })

  it('docId и K_link — независимые CSPRNG-значения', () => {
    const a = createDocumentKeys()
    const b = createDocumentKeys()
    expect(isDocId(a.docId)).toBe(true)
    expect(a.docId).toHaveLength(SIZES.DOC_ID_CHARS)
    expect(a.docIdBytes).toHaveLength(SIZES.DOC_ID_BYTES)
    expect(a.linkSecret).toHaveLength(SIZES.LINK_SECRET_BYTES)
    expect(a.docId).not.toBe(b.docId)
    expect(timingSafeEqual(a.linkSecret, b.linkSecret)).toBe(false)
    // фрагмент не является функцией docId
    expect(buildFragment(a.linkSecret)).not.toBe(buildFragment(b.linkSecret))
  })

  it('round-trip разбора: полный URL, короткая форма, чужой префикс', () => {
    const keys = createDocumentKeys()
    for (const route of ['/p', '/f']) {
      const link = buildLink(ORIGIN, keys, route)
      const parsed = parseLink(link)
      expect(parsed.docId).toBe(keys.docId)
      expect(parsed.version).toBe(1)
      expect(timingSafeEqual(parsed.linkSecret, keys.linkSecret)).toBe(true)
    }
    const short = `${keys.docId}#${buildFragment(keys.linkSecret)}`
    expect(parseLink(short).docId).toBe(keys.docId)
    expect(parseLink(`  ${short}  `).docId).toBe(keys.docId)
    // адрес после sealAddressBar плюс возвращённый вручную фрагмент
    expect(parseLink(`${ORIGIN}/p/${keys.docId}?d=1#${buildFragment(keys.linkSecret)}`).docId).toBe(
      keys.docId,
    )
  })

  it('ввод человеком: дефисы, пробелы, нижний регистр, I/O', () => {
    const keys = documentKeysFrom(DOC_ID, LINK_SECRET)
    const grouped = `${groupForDisplay(DOC_ID)}#${groupForDisplay(FRAGMENT)}`
    const parsed = parseLink(grouped)
    expect(parsed.docId).toBe(DOC_ID)
    expect(timingSafeEqual(parsed.linkSecret, keys.linkSecret)).toBe(true)
    expect(parseLink(grouped.toLowerCase()).docId).toBe(DOC_ID)
  })

  it('битый base32 и битая версия фрагмента — отказ', () => {
    expect(tryParseLink('нет решётки')).toBeNull()
    expect(tryParseLink(`${DOC_ID}#${FRAGMENT.slice(0, 52)}`)).toBeNull()
    expect(tryParseLink(`${DOC_ID}#${'U'.repeat(53)}`)).toBeNull()
    expect(tryParseLink(`${DOC_ID.slice(0, 19)}#${FRAGMENT}`)).toBeNull()
    expect(() => parseLink(`${DOC_ID}#${FRAGMENT}X`)).toThrowError(LinkError)
    // версия фрагмента 0x02 неизвестна
    const wrongVersion = b32encode(Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? 2 : i)))
    expect(() => parseFragment(wrongVersion)).toThrowError(LinkError)
    expect(() => buildFragment(new Uint8Array(31))).toThrowError(LinkError)
  })

  it('фрагмент читается и с ведущей решёткой', () => {
    expect(parseFragment(`#${FRAGMENT}`).version).toBe(1)
  })
})

describe('фрагмент в адресной строке (§5.2)', () => {
  const makeLocation = (href: string, pathname: string): Location =>
    ({ href, pathname }) as unknown as Location

  it('consumeLinkFromLocation разбирает и НЕ стирает фрагмент', () => {
    const keys = createDocumentKeys()
    const href = buildLink(ORIGIN, keys)
    const calls: string[] = []
    const hist = {
      replaceState: (_s: unknown, _t: string, url: string) => calls.push(url),
    } as unknown as History
    const parsed = consumeLinkFromLocation(
      makeLocation(href, `${APP_PREFIX.planer}/${keys.docId}`),
      hist,
    )
    expect(parsed?.docId).toBe(keys.docId)
    expect(calls).toHaveLength(0)
  })

  it('адрес без фрагмента — null, приложение работает по локальным данным', () => {
    expect(
      consumeLinkFromLocation(makeLocation(`${ORIGIN}/p/${DOC_ID}?d=1`, `/p/${DOC_ID}`), undefined),
    ).toBeNull()
    expect(consumeLinkFromLocation(makeLocation('', ''), undefined)).toBeNull()
  })

  it('sealAddressBar приводит адрес к /p/<docId>?d=1', () => {
    const keys = createDocumentKeys()
    const calls: string[] = []
    const hist = {
      replaceState: (_s: unknown, _t: string, url: string) => calls.push(url),
    } as unknown as History
    sealAddressBar(keys.docId, hist, makeLocation('', `${APP_PREFIX.planer}/${keys.docId}`))
    expect(calls).toEqual([`${APP_PREFIX.planer}/${keys.docId}?d=1`])

    sealAddressBar(keys.docId, hist, makeLocation('', '/somewhere/else'))
    expect(calls[1]).toBe(`${APP_PREFIX.planer}/${keys.docId}?d=1`)
    expect(calls[1]).not.toContain('#')
  })

  it('без History ничего не падает', () => {
    expect(() => sealAddressBar(DOC_ID as never, undefined, undefined)).not.toThrow()
  })
})

describe('одноразовое приглашение (§5.3)', () => {
  it('round-trip: iid из секрета, blob разворачивается в ссылку', async () => {
    const keys = createDocumentKeys()
    const invite = await createInviteMaterial(keys)
    expect(invite.iid).toHaveLength(SIZES.DOC_ID_CHARS)
    expect(invite.blob).toHaveLength(INVITE_BLOB_BYTES)
    expect(invite.url.startsWith(`${ORIGIN}/i/${invite.iid}#`)).toBe(true)
    expect(invite.expiresAt - Date.now()).toBeGreaterThan(C.INVITE_TTL_MS - 5_000)
    expect(invite.expiresAt - Date.now()).toBeLessThanOrEqual(C.INVITE_TTL_MS)
    expect(await inviteIdFromSecret(invite.secret)).toBe(invite.iid)

    const parsed = parseInviteUrl(invite.url)
    expect(parsed?.iid).toBe(invite.iid)
    const link = await openInviteBlob((parsed as { secret: Uint8Array }).secret, invite.blobB32)
    expect(link.docId).toBe(keys.docId)
    expect(timingSafeEqual(link.linkSecret, keys.linkSecret)).toBe(true)
  })

  it('iid не раскрывает ни K_link, ни docId', async () => {
    const keys = createDocumentKeys()
    const invite = await createInviteMaterial(keys)
    expect(invite.iid).not.toBe(keys.docId)
    expect(invite.blobB32).not.toContain(keys.docId)
    // два приглашения на один документ не связываются между собой по iid
    const second = await createInviteMaterial(keys)
    expect(second.iid).not.toBe(invite.iid)
  })

  it('чужой секрет и порченый blob не расшифровываются', async () => {
    const keys = createDocumentKeys()
    const invite = await createInviteMaterial(keys)
    const foreign = await createInviteMaterial(createDocumentKeys())
    await expect(openInviteBlob(foreign.secret, invite.blob)).rejects.toThrowError(LinkError)
    const damaged = invite.blob.slice()
    damaged[0] = (damaged[0] as number) ^ 0xff
    await expect(openInviteBlob(invite.secret, damaged)).rejects.toMatchObject({
      reason: 'bad-invite',
    })
    await expect(openInviteBlob(invite.secret, 'НЕВЕРНО')).rejects.toMatchObject({
      reason: 'bad-invite',
    })
  })

  it('битая ссылка-приглашение — null', () => {
    expect(parseInviteUrl('нет решётки')).toBeNull()
    expect(parseInviteUrl(`${ORIGIN}/i/КОРОТКО#${FRAGMENT}`)).toBeNull()
    expect(parseInviteUrl(`${ORIGIN}/i/${DOC_ID}#мусор`)).toBeNull()
  })
})

describe('файл-ключ (§5.6)', () => {
  it('по умолчанию зашифрован парольной фразой', async () => {
    const keys = createDocumentKeys()
    const passphrase = 'сокол ландыш верстак печенье гамак'
    const file = await exportRecovery(keys, {
      protect: { mode: 'passphrase', passphrase },
    })
    expect(file.filename).toBe(`elementar-${keys.docId}-recovery.txt`)
    expect(file.body).not.toContain(buildFragment(keys.linkSecret))
    const restored = await importRecovery(file.body, passphrase)
    expect(restored.docId).toBe(keys.docId)
    expect(timingSafeEqual(restored.linkSecret, keys.linkSecret)).toBe(true)

    await expect(importRecovery(file.body, 'другая фраза совсем')).rejects.toThrowError(LinkError)
    await expect(importRecovery(file.body)).rejects.toMatchObject({ reason: 'bad-recovery' })
  })

  it('режим plain кладёт ссылку открытым текстом — осознанный выбор', async () => {
    const keys = createDocumentKeys()
    const file = await exportRecovery(keys, { protect: { mode: 'plain' } })
    expect(file.body).toContain(buildFragment(keys.linkSecret))
    const restored = await importRecovery(file.body)
    expect(restored.docId).toBe(keys.docId)
    expect(timingSafeEqual(restored.linkSecret, keys.linkSecret)).toBe(true)
  })

  it('чужой файл отвергается', async () => {
    await expect(importRecovery('не json')).rejects.toMatchObject({ reason: 'bad-recovery' })
    await expect(importRecovery('{"a":1}')).rejects.toMatchObject({ reason: 'bad-recovery' })
    await expect(
      importRecovery('{"elementar":"elementar-recovery","v":1,"docId":"' + DOC_ID + '"}'),
    ).rejects.toMatchObject({ reason: 'bad-recovery' })
  })
})
