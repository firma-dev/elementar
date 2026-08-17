/**
 * §9.2: два раздельных бакета. Главное свойство — miss-бакет физически не может
 * заблокировать запрос с валидной подписью, а жёсткий блок не длится дольше 15 минут.
 */
import { describe, expect, it } from 'vitest'
import { BUCKETS, C, missCost } from '@elementar/proto'
import { LimiterCore } from '../src/do/limiter.js'

function clocked(): { core: LimiterCore; tick: (ms: number) => void; now: () => number } {
  const state = { now: 1_800_000_000_000 }
  const core = new LimiterCore(() => state.now)
  return { core, tick: (ms) => (state.now += ms), now: () => state.now }
}

describe('лимитер', () => {
  it('цена промаха растёт 5, 10, 20, 40, 80 и упирается в 80', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(missCost)).toEqual([5, 10, 20, 40, 80, 80, 80])
  })

  it('auth-бакет: ёмкость 240, пополнение 4/с', () => {
    const { core, tick } = clocked()
    expect(BUCKETS.auth.capacity).toBe(240)
    for (let i = 0; i < 9; i++) expect(core.charge('p', { kind: 'auth', cost: 25 }).ok).toBe(true)
    const denied = core.charge('p', { kind: 'auth', cost: 25 })
    expect(denied.ok).toBe(false)
    expect(denied.reason).toBe('rate')

    tick(10_000) // +40 токенов
    expect(core.charge('p', { kind: 'auth', cost: 25 }).ok).toBe(true)
  })

  it('исчерпание miss-бакета даёт челлендж, а не блок', () => {
    const { core } = clocked()
    expect(core.charge('p', { kind: 'miss' }).ok).toBe(true) // 5 → 15
    expect(core.state('p').miss.tokens).toBeCloseTo(BUCKETS.miss.capacity - 5, 5)
    expect(core.charge('p', { kind: 'miss' }).ok).toBe(true) // 10 → 5
    expect(core.state('p').miss.tokens).toBeCloseTo(5, 5)

    const third = core.charge('p', { kind: 'miss' }) // 20 → 0
    expect(third.ok).toBe(false)
    expect(third.reason).toBe('challenge')
    expect(third.challengeRequired).toBe(true)
    expect(core.challengeActive('p')).toBe(true)
  })

  it('пустой miss-бакет не мешает auth-бакету', () => {
    const { core } = clocked()
    for (let i = 0; i < 5; i++) core.charge('p', { kind: 'miss' })
    expect(core.state('p').miss.tokens).toBe(0)
    expect(core.charge('p', { kind: 'auth', cost: 5 }).ok).toBe(true)
  })

  it('20 промахов подряд дают блок не длиннее 15 минут', () => {
    const { core } = clocked()
    let blocked: number | undefined
    for (let i = 0; i < C.MISS_STREAK_BLOCK; i++) {
      const d = core.charge('p', { kind: 'miss', blockKey: 'full-ip' })
      if (d.reason === 'blocked') blocked = d.retryAfter
    }
    expect(blocked).toBeDefined()
    expect(blocked ?? 0).toBeLessThanOrEqual(C.BLOCK_MAX_MS / 1000)

    // сколько бы страйков ни накопилось, потолок остаётся 15 минут
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < C.MISS_STREAK_BLOCK; i++) {
        const d = core.charge('p', { kind: 'miss', blockKey: 'full-ip' })
        if (d.reason === 'blocked')
          expect(d.retryAfter ?? 0).toBeLessThanOrEqual(C.BLOCK_MAX_MS / 1000)
      }
    }
    expect(core.state('full-ip').blockedUntil - core.state('p').touchedAt).toBeLessThanOrEqual(
      C.BLOCK_MAX_MS,
    )
  })

  it('успешный аутентифицированный ответ снижает missStreak', () => {
    const { core } = clocked()
    core.charge('p', { kind: 'miss' })
    core.charge('p', { kind: 'miss' })
    expect(core.state('p').missStreak).toBe(2)
    core.success('p')
    expect(core.state('p').missStreak).toBe(1)
    core.success('p')
    core.success('p')
    expect(core.state('p').missStreak).toBe(0)
  })

  it('30 минут без промахов обнуляют missStreak', () => {
    const { core, tick } = clocked()
    core.charge('p', { kind: 'miss' })
    expect(core.state('p').missStreak).toBe(1)
    tick(31 * 60_000)
    expect(core.state('p').missStreak).toBe(0)
  })

  it('квота создания: 5 в час и 20 в сутки', () => {
    const { core, tick } = clocked()
    for (let i = 0; i < 5; i++) expect(core.createQuota('p').ok).toBe(true)
    expect(core.createQuota('p').ok).toBe(false)

    let created = 5
    for (let hour = 0; hour < 5; hour++) {
      tick(3_600_001)
      for (let i = 0; i < 5; i++) if (core.createQuota('p').ok) created++
    }
    expect(created).toBe(20)
  })

  it('выселение нетронутых записей освобождает память', () => {
    const { core, tick } = clocked()
    core.charge('a', { kind: 'auth', cost: 1 })
    core.charge('b', { kind: 'auth', cost: 1 })
    expect(core.size()).toBe(2)
    tick(16 * 60_000)
    core.sweep()
    expect(core.size()).toBe(0)
  })

  it('снапшот состояния переживает перезагрузку DO', () => {
    const { core } = clocked()
    core.charge('p', { kind: 'auth', cost: 100 })
    const dumped = JSON.parse(JSON.stringify(core.dump())) as ReturnType<LimiterCore['dump']>
    const revived = new LimiterCore(() => 1_800_000_000_000)
    revived.load(dumped)
    expect(revived.state('p').auth.tokens).toBeCloseTo(BUCKETS.auth.capacity - 100, 5)
  })
})
