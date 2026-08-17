import { describe, expect, it } from 'vitest'
import { PRESENCE_TTL_MS } from '@elementar/core'
import type { ActorRecord, PresencePayload } from '@elementar/core'
import {
  acceptArgs,
  acceptLabel,
  digestLine,
  formatLastSeen,
  keptIndices,
  peersOf,
  plural,
  qrMatrix,
  qrPath,
  qrSvg,
  recoveryKind,
  TASKS,
  withCount,
} from '../src/index.js'

describe('QR', () => {
  const link = 'https://elementar.example/p/K7M4Q8XB2NF3YT9WCPRS#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

  it('строит квадратную матрицу с искателем в углу', () => {
    const m = qrMatrix(link)
    expect(m.size).toBeGreaterThanOrEqual(21)
    expect(m.rows).toHaveLength(m.size)
    for (const row of m.rows) expect(row).toHaveLength(m.size)
    // Верхний левый искатель: 7 тёмных модулей и белый разделитель за ним
    expect(m.rows[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true])
    expect(m.rows[0]?.[7]).toBe(false)
  })

  it('склеивает горизонтальные пробеги в один путь', () => {
    const m = qrMatrix(link)
    const path = qrPath(m)
    expect(path.startsWith('M0 0h7')).toBe(true)
    const rects = path.split('M').length - 1
    const darkModules = m.rows.flat().filter(Boolean).length
    expect(rects).toBeLessThan(darkModules)
  })

  it('отдаёт SVG с тихой зоной 4 модуля', () => {
    const svg = qrSvg('короткая', { title: 'QR' })
    const m = qrMatrix('короткая')
    expect(svg).toContain(`viewBox="0 0 ${m.size + 8} ${m.size + 8}"`)
    expect(svg).toContain('<title>QR</title>')
    expect(svg).toContain('var(--e-fg)')
  })
})

describe('склонения и время', () => {
  it('склоняет числительные', () => {
    expect(plural(1, TASKS)).toBe('задача')
    expect(plural(2, TASKS)).toBe('задачи')
    expect(plural(5, TASKS)).toBe('задач')
    expect(plural(11, TASKS)).toBe('задач')
    expect(plural(21, TASKS)).toBe('задача')
    expect(plural(112, TASKS)).toBe('задач')
    expect(plural(102, TASKS)).toBe('задачи')
    expect(withCount(7, TASKS)).toBe('7 задач')
  })

  it('пишет время по-человечески', () => {
    const now = Date.parse('2026-08-16T12:00:00Z')
    expect(formatLastSeen(now - 30_000, now)).toBe('только что')
    expect(formatLastSeen(now - 12 * 60_000, now)).toBe('12 минут назад')
    expect(formatLastSeen(now - 65 * 60_000, now)).toBe('час назад')
    expect(formatLastSeen(now - 5 * 3_600_000, now)).toBe('5 часов назад')
    expect(formatLastSeen(now - 30 * 3_600_000, now)).toBe('вчера')
  })
})

describe('выбор предложений', () => {
  it('крестик убирает одно, кнопка принимает остальные', () => {
    const kept = keptIndices(3, new Set([1]))
    expect(kept).toEqual([0, 2])
    expect(acceptArgs(3, kept)).toEqual([0, 2])
    expect(acceptLabel(kept.length, TASKS)).toBe('Оставить 2 задачи')
  })

  it('когда оставляют всё, only не передаётся', () => {
    const kept = keptIndices(4, new Set())
    expect(acceptArgs(4, kept)).toBeUndefined()
    expect(acceptLabel(4, TASKS)).toBe('Оставить 4 задачи')
  })
})

describe('присутствие', () => {
  const me = 'AAAAAAAA'
  const her = 'BBBBBBBB'
  const now = 1_700_000_000_000
  const actors: ActorRecord[] = [
    { id: me, name: 'Виктор', lastSeenAt: now },
    { id: her, name: 'Аня', lastSeenAt: now - 3_600_000 },
  ]

  it('себя не показывает, чужого — с местом', () => {
    const payloads: PresencePayload[] = [
      { actor: her, view: { kind: 'list', list: 'Быт' }, editing: null, chainHead: '', at: now - 1000 },
      { actor: me, view: { kind: 'today' }, editing: null, chainHead: '', at: now },
    ]
    const peers = peersOf({ payloads, actors, me, now })
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ actor: her, name: 'Аня', online: true, where: 'Быт' })
    expect(peers[0]?.slot === 'a' || peers[0]?.slot === 'b').toBe(true)
  })

  it('протухшее присутствие считается офлайном', () => {
    const payloads: PresencePayload[] = [
      {
        actor: her,
        view: { kind: 'calendar' },
        editing: null,
        chainHead: '',
        at: now - PRESENCE_TTL_MS - 1,
      },
    ]
    const peers = peersOf({ payloads, actors, me, now })
    expect(peers[0]?.online).toBe(false)
    expect(peers[0]?.where).toBeUndefined()
  })
})

describe('дайджест', () => {
  it('складывает строку без родов', () => {
    expect(digestLine({ actor: 'BBBBBBBB', name: 'Аня', created: 3, updated: 1, deleted: 0 })).toBe(
      'добавлено 3, изменено 1',
    )
    expect(digestLine({ actor: 'BBBBBBBB', name: 'Аня', created: 0, updated: 0, deleted: 0 })).toBe('без изменений')
  })
})

describe('файл-ключ', () => {
  it('различает открытый, зашифрованный и чужой файл', () => {
    const plain = JSON.stringify({ elementar: 'elementar-recovery', v: 1, docId: 'X', link: 'https://x#y' })
    const sealed = JSON.stringify({ elementar: 'elementar-recovery', v: 1, docId: 'X', route: '/p', nonce: 'AA', ct: 'BB' })
    expect(recoveryKind(plain)).toBe('plain')
    expect(recoveryKind(sealed)).toBe('sealed')
    expect(recoveryKind('{"что-то":1}')).toBe('not-recovery')
    expect(recoveryKind('не json вовсе')).toBe('not-recovery')
  })
})
