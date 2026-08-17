import { describe, expect, it } from 'vitest'
import { PRESENCE_CT_BYTES } from '@elementar/proto'
import {
  PRESENCE_TTL_MS,
  PresenceTracker,
  openPresence,
  parsePresencePayload,
  presenceCtBytes,
  presenceSlot,
  sealPresence,
} from '../../src/sync/presence.js'
import type { PresencePayload } from '../../src/sync/presence.js'
import { createNonceSource } from '../../src/crypto/nonce.js'
import { generateDocKey } from '../../src/crypto/keys.js'

const docIdBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

function payload(patch: Partial<PresencePayload> = {}): PresencePayload {
  return {
    actor: 'aaaaaaaa',
    view: { kind: 'list', list: 'list:byt' },
    editing: null,
    chainHead: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    at: 1_000,
    ...patch,
  }
}

describe('присутствие: шифрованный блоб', () => {
  it('запечатанный блоб влезает в 256 байт и открывается своим ключом', async () => {
    const key = generateDocKey()
    const nonce = createNonceSource()
    const ct = await sealPresence({ key, docIdBytes, nonce, payload: payload() })
    expect(ct).not.toBeNull()
    if (ct === null) return
    expect(presenceCtBytes(ct)).toBeLessThanOrEqual(PRESENCE_CT_BYTES)
    const back = await openPresence({ key, docIdBytes, ct })
    expect(back?.actor).toBe('aaaaaaaa')
    expect(back?.view).toEqual({ kind: 'list', list: 'list:byt' })
  })

  it('чужой ключ и чужой документ ничего не открывают', async () => {
    const key = generateDocKey()
    const nonce = createNonceSource()
    const ct = await sealPresence({ key, docIdBytes, nonce, payload: payload() })
    if (ct === null) throw new Error('нет блоба')
    expect(await openPresence({ key: generateDocKey(), docIdBytes, ct })).toBeNull()
    expect(await openPresence({ key, docIdBytes: new Uint8Array(12), ct })).toBeNull()
  })

  it('мусор разбирается в null, а не в исключение', () => {
    expect(parsePresencePayload('{')).toBeNull()
    expect(parsePresencePayload({ actor: 1 })).toBeNull()
    expect(parsePresencePayload({ ...payload(), view: { kind: 'unknown' } })).toBeNull()
  })
})

describe('присутствие: комната', () => {
  it('пиры протухают через 30 секунд', () => {
    const t = new PresenceTracker()
    t.put('s1', payload(), 0)
    expect(t.list(PRESENCE_TTL_MS).length).toBe(1)
    expect(t.list(PRESENCE_TTL_MS + 1).length).toBe(0)
  })

  it('больше восьми пиров в комнату не берётся', () => {
    const t = new PresenceTracker()
    for (let i = 0; i < 12; i++) t.put(`s${i}`, payload({ actor: `a${i}` }), 0)
    expect(t.size).toBe(8)
  })

  it('головы цепочки живых пиров доступны для сверки', () => {
    const t = new PresenceTracker()
    t.put('s1', payload({ chainHead: 'AAAA' }), 0)
    t.put('s2', payload({ chainHead: 'BBBB' }), 0)
    expect(t.heads(0).sort()).toEqual(['AAAA', 'BBBB'])
  })

  it('слот цвета вычисляется из отсортированных акторов', () => {
    expect(presenceSlot(['bbbb', 'aaaa'], 'aaaa')).toBe('a')
    expect(presenceSlot(['bbbb', 'aaaa'], 'bbbb')).toBe('b')
  })
})
