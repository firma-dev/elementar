import { describe, expect, it } from 'vitest'
import { BACKOFF_STEPS_MS, C } from '@elementar/proto'
import {
  HOLD_MS,
  humanState,
  initialState,
  reduce,
  reduceAll,
  statusOf,
} from '../../src/sync/machine.js'
import type { Effect, MachineState, SyncEvent } from '../../src/sync/machine.js'

/** Джиттер без случайности: 0.5 даёт ровно шаг лестницы. */
const CFG = { rnd: (): number => 0.5 }

function run(state: MachineState, events: SyncEvent[]): { state: MachineState; effects: Effect[] } {
  return reduceAll(state, events, CFG)
}

function kinds(effects: Effect[]): string[] {
  return effects.map((e) => e.e)
}

function opened(patch: Partial<MachineState> = {}): MachineState {
  const r = run(initialState(patch), [{ t: 'OPEN', at: 0 }])
  return r.state
}

describe('автомат синка: открытие', () => {
  it('LOADED при живой сети ведёт в CONNECTING и просит соединение', () => {
    const r = run(opened(), [{ t: 'LOADED', at: 10, since: 42, pending: 0 }])
    expect(r.state.phase).toBe('connecting')
    expect(r.state.since).toBe(42)
    expect(r.effects).toContainEqual({ e: 'connect', since: 42 })
  })

  it('LOADED без сети оставляет документ локальным и ничего не подключает', () => {
    const r = run(opened({ online: false }), [{ t: 'LOADED', at: 10, since: 3, pending: 2 }])
    expect(r.state.phase).toBe('local')
    expect(kinds(r.effects)).not.toContain('connect')
    expect(r.state.pending).toBe(2)
  })

  it('выключенный синк не подключается даже онлайн', () => {
    const r = run(opened({ syncEnabled: false }), [{ t: 'LOADED', at: 1, since: 0, pending: 0 }])
    expect(r.state.phase).toBe('local')
    expect(kinds(r.effects)).not.toContain('connect')
  })
})

describe('автомат синка: catchup и live', () => {
  const live = (pending = 0): MachineState => {
    const a = run(opened(), [
      { t: 'LOADED', at: 0, since: 10, pending },
      { t: 'SOCK_OPEN', at: 1 },
      {
        t: 'WELCOME',
        at: 2,
        head: 12,
        snapshotSeq: 5,
        peers: 1,
        compactionNeeded: false,
        safeCompactSeq: 10,
      },
      { t: 'OPS', at: 3, count: 2, upto: 12 },
      { t: 'DRAINED', at: 4 },
    ])
    return a.state
  }

  it('welcome → catchup, ops двигают since, drained → live', () => {
    const s = live()
    expect(s.phase).toBe('live')
    expect(s.since).toBe(12)
    expect(s.peers).toBe(1)
    expect(s.lastSyncedAt).toBe(4)
  })

  it('welcome со снапшотом впереди требует resync, а не догон дельтами', () => {
    const r = run(opened(), [
      { t: 'LOADED', at: 0, since: 3, pending: 0 },
      {
        t: 'WELCOME',
        at: 1,
        head: 90,
        snapshotSeq: 40,
        peers: 0,
        compactionNeeded: false,
        safeCompactSeq: 40,
      },
    ])
    expect(r.state.phase).toBe('catchup')
    expect(r.effects).toContainEqual({ e: 'resync', snapshotSeq: 40 })
  })

  it('сводка «пока вас не было» просится только выше порога', () => {
    const base = run(opened(), [
      { t: 'LOADED', at: 0, since: 0, pending: 0 },
      {
        t: 'WELCOME',
        at: 1,
        head: 100,
        snapshotSeq: 0,
        peers: 1,
        compactionNeeded: false,
        safeCompactSeq: 0,
      },
    ]).state

    const few = run(base, [
      { t: 'OPS', at: 2, count: C.DIGEST_THRESHOLD, upto: 5 },
      { t: 'DRAINED', at: 3 },
    ])
    expect(kinds(few.effects)).not.toContain('digest')

    const many = run(base, [
      { t: 'OPS', at: 2, count: C.DIGEST_THRESHOLD + 1, upto: 6 },
      { t: 'DRAINED', at: 3 },
    ])
    expect(many.effects).toContainEqual({ e: 'digest', applied: C.DIGEST_THRESHOLD + 1 })
  })

  it('локальная правка в LIVE немедленно просит отправку', () => {
    const r = reduce(live(), { t: 'LOCAL_OP', at: 5 }, CFG)
    expect(r.state.pending).toBe(1)
    expect(r.effects).toContainEqual({ e: 'send', since: 12 })
  })
})

describe('автомат синка: офлайн-накопление', () => {
  it('правки копятся локально и уезжают после welcome', () => {
    let s = run(opened({ online: false }), [{ t: 'LOADED', at: 0, since: 7, pending: 0 }]).state
    for (let i = 0; i < 20; i++) {
      const r = reduce(s, { t: 'LOCAL_OP', at: 100 + i }, CFG)
      s = r.state
      expect(kinds(r.effects)).not.toContain('send')
    }
    expect(s.pending).toBe(20)
    expect(humanState(s)).toBe('offline')

    const online = run(s, [
      { t: 'NET_ONLINE', at: 200 },
      {
        t: 'WELCOME',
        at: 201,
        head: 7,
        snapshotSeq: 7,
        peers: 0,
        compactionNeeded: false,
        safeCompactSeq: 7,
      },
    ])
    expect(online.state.phase).toBe('live')
    expect(online.effects).toContainEqual({ e: 'connect', since: 7 })
    expect(online.effects).toContainEqual({ e: 'send', since: 7 })
  })

  it('уход в офлайн с непустой очередью просит keepalive-флаш', () => {
    const s = run(opened(), [
      { t: 'LOADED', at: 0, since: 0, pending: 3 },
      {
        t: 'WELCOME',
        at: 1,
        head: 0,
        snapshotSeq: 0,
        peers: 0,
        compactionNeeded: false,
        safeCompactSeq: 0,
      },
    ]).state
    const r = reduce(s, { t: 'NET_OFFLINE', at: 5 }, CFG)
    expect(r.state.phase).toBe('local')
    expect(r.state.online).toBe(false)
    expect(r.effects).toContainEqual({ e: 'flushHttp', reason: 'offline' })
    expect(kinds(r.effects)).toContain('disconnect')
  })

  it('NET_ONLINE в скрытой вкладке не дёргает сокет', () => {
    const s = run(opened(), [
      { t: 'LOADED', at: 0, since: 0, pending: 0 },
      { t: 'HIDDEN', at: 1 },
      { t: 'NET_OFFLINE', at: 2 },
    ]).state
    const r = reduce(s, { t: 'NET_ONLINE', at: 3 }, CFG)
    expect(kinds(r.effects)).not.toContain('connect')
  })
})

describe('автомат синка: идемпотентность подтверждений', () => {
  it('повторный ACK не уводит очередь в минус', () => {
    let s = run(opened(), [{ t: 'LOADED', at: 0, since: 0, pending: 4 }]).state
    s = reduce(s, { t: 'ACK', at: 1, acked: 4, head: 4 }, CFG).state
    expect(s.pending).toBe(0)
    s = reduce(s, { t: 'ACK', at: 2, acked: 4, head: 4 }, CFG).state
    expect(s.pending).toBe(0)
  })

  it('точный остаток из ответа сервера побеждает подсчёт по разнице', () => {
    const s0 = run(opened(), [{ t: 'LOADED', at: 0, since: 0, pending: 10 }]).state
    const s1 = reduce(s0, { t: 'ACK', at: 1, acked: 3, head: 3, pending: 6 }, CFG).state
    expect(s1.pending).toBe(6)
  })

  it('дубликаты в ack не считаются новой отправкой', () => {
    const s0 = run(opened(), [{ t: 'LOADED', at: 0, since: 0, pending: 2 }]).state
    const s1 = reduce(s0, { t: 'ACK', at: 1, acked: 2, head: 9, pending: 0 }, CFG).state
    const s2 = reduce(s1, { t: 'ACK', at: 2, acked: 2, head: 9, pending: 0 }, CFG).state
    expect(s2.pending).toBe(0)
    expect(s2.head).toBe(9)
  })
})

describe('автомат синка: переподключение и бэкофф', () => {
  const connectedState = (): MachineState =>
    run(opened(), [
      { t: 'LOADED', at: 0, since: 5, pending: 0 },
      { t: 'SOCK_OPEN', at: 1 },
      {
        t: 'WELCOME',
        at: 2,
        head: 5,
        snapshotSeq: 0,
        peers: 1,
        compactionNeeded: false,
        safeCompactSeq: 5,
      },
      { t: 'DRAINED', at: 3 },
    ]).state

  it('разрыв уводит в BACKOFF и планирует попытку по лестнице', () => {
    const r = reduce(connectedState(), { t: 'SOCK_CLOSE', at: 1000 }, CFG)
    expect(r.state.phase).toBe('backoff')
    expect(r.state.peers).toBe(0)
    expect(r.state.retryAt).toBe(1000 + (BACKOFF_STEPS_MS[0] as number))
    expect(r.effects).toContainEqual({
      e: 'schedule',
      at: 1000 + (BACKOFF_STEPS_MS[0] as number),
      reason: 'backoff',
    })
  })

  it('таймер бэкоффа приводит к новой попытке соединения', () => {
    const s = reduce(connectedState(), { t: 'SOCK_CLOSE', at: 0 }, CFG).state
    const r = reduce(s, { t: 'TIMER', at: s.retryAt as number }, CFG)
    expect(r.state.phase).toBe('connecting')
    expect(r.effects).toContainEqual({ e: 'connect', since: 5 })
  })

  it('лестница растёт до потолка 60 с и не дальше', () => {
    let s = connectedState()
    const delays: number[] = []
    let at = 0
    for (let i = 0; i < 10; i++) {
      const closed = reduce(s, { t: 'SOCK_CLOSE', at }, CFG)
      delays.push((closed.state.retryAt as number) - at)
      at = closed.state.retryAt as number
      const retried = reduce(closed.state, { t: 'TIMER', at }, CFG)
      s = reduce(retried.state, { t: 'SOCK_OPEN', at: at + 1 }, CFG).state
    }
    expect(delays.slice(0, BACKOFF_STEPS_MS.length)).toEqual([...BACKOFF_STEPS_MS])
    expect(delays.slice(BACKOFF_STEPS_MS.length).every((d) => d === C.BACKOFF_MAX_MS)).toBe(true)
  })

  it('удержание соединения 30 с обнуляет счётчик попыток', () => {
    const s0 = reduce(connectedState(), { t: 'SOCK_CLOSE', at: 0 }, CFG).state
    expect(s0.attempt).toBe(1)
    const reconnect = run(s0, [
      { t: 'TIMER', at: s0.retryAt as number },
      { t: 'SOCK_OPEN', at: 2000 },
      {
        t: 'WELCOME',
        at: 2001,
        head: 5,
        snapshotSeq: 0,
        peers: 0,
        compactionNeeded: false,
        safeCompactSeq: 5,
      },
    ])
    expect(reconnect.state.attempt).toBe(1)
    const held = reduce(reconnect.state, { t: 'TIMER', at: 2001 + HOLD_MS }, CFG)
    expect(held.state.attempt).toBe(0)
  })

  it('ELM_RATE_LIMITED ждёт ровно столько, сколько сказал сервер', () => {
    const r = reduce(connectedState(), { t: 'ERR_RATE', at: 100, retryAfterMs: 7_000 }, CFG)
    expect(r.state.phase).toBe('backoff')
    expect(r.state.retryAt).toBe(7_100)
    expect(r.state.error?.code).toBe('ELM_RATE_LIMITED')
  })

  it('разрыв при выключенной сети не планирует попыток', () => {
    const s = { ...connectedState(), online: false }
    const r = reduce(s, { t: 'SOCK_CLOSE', at: 10 }, CFG)
    expect(r.state.phase).toBe('local')
    expect(r.state.retryAt).toBeNull()
    expect(kinds(r.effects)).not.toContain('schedule')
  })
})

describe('автомат синка: фон и выгрузка', () => {
  const liveState = (pending = 0): MachineState =>
    run(opened(), [
      { t: 'LOADED', at: 0, since: 1, pending },
      {
        t: 'WELCOME',
        at: 1,
        head: 1,
        snapshotSeq: 0,
        peers: 1,
        compactionNeeded: false,
        safeCompactSeq: 1,
      },
      { t: 'DRAINED', at: 2 },
    ]).state

  it('скрытая вкладка держит сокет минуту, потом PAUSED', () => {
    const hidden = reduce(liveState(2), { t: 'HIDDEN', at: 10 }, CFG)
    expect(hidden.effects).toContainEqual({ e: 'flushHttp', reason: 'hidden' })
    expect(hidden.effects).toContainEqual({
      e: 'schedule',
      at: 10 + C.HIDDEN_DISCONNECT_MS,
      reason: 'hidden',
    })
    expect(hidden.state.phase).toBe('live')

    const paused = reduce(hidden.state, { t: 'TIMER', at: 10 + C.HIDDEN_DISCONNECT_MS }, CFG)
    expect(paused.state.phase).toBe('paused')
    expect(paused.effects).toContainEqual({ e: 'disconnect', reason: 'paused' })
  })

  it('возврат на экран подключается немедленно', () => {
    const paused = run(liveState(), [
      { t: 'HIDDEN', at: 0 },
      { t: 'TIMER', at: C.HIDDEN_DISCONNECT_MS },
    ]).state
    const r = reduce(paused, { t: 'VISIBLE', at: C.HIDDEN_DISCONNECT_MS + 5 }, CFG)
    expect(r.state.phase).toBe('connecting')
    expect(r.effects).toContainEqual({ e: 'connect', since: 1 })
  })

  it('возврат до минуты отменяет закрытие сокета', () => {
    const r = run(liveState(), [
      { t: 'HIDDEN', at: 0 },
      { t: 'VISIBLE', at: 1_000 },
    ])
    expect(r.state.phase).toBe('live')
    expect(r.state.timer).toBeNull()
  })

  it('pagehide флашит очередь только когда есть что', () => {
    expect(kinds(reduce(liveState(0), { t: 'PAGEHIDE', at: 1 }, CFG).effects)).not.toContain(
      'flushHttp',
    )
    expect(reduce(liveState(3), { t: 'PAGEHIDE', at: 1 }, CFG).effects).toContainEqual({
      e: 'flushHttp',
      reason: 'pagehide',
    })
  })
})

describe('автомат синка: ошибки', () => {
  const liveState = (): MachineState =>
    run(opened(), [
      { t: 'LOADED', at: 0, since: 0, pending: 0 },
      {
        t: 'WELCOME',
        at: 1,
        head: 0,
        snapshotSeq: 0,
        peers: 0,
        compactionNeeded: false,
        safeCompactSeq: 0,
      },
      { t: 'DRAINED', at: 2 },
    ]).state

  it('ERR_AUTH — терминальный DENIED, дальнейшие события игнорируются', () => {
    const denied = reduce(liveState(), { t: 'ERR_AUTH', at: 5 }, CFG).state
    expect(denied.phase).toBe('denied')
    const after = run(denied, [
      { t: 'NET_ONLINE', at: 6 },
      { t: 'VISIBLE', at: 7 },
      { t: 'SOCK_CLOSE', at: 8 },
    ])
    expect(after.state.phase).toBe('denied')
    expect(kinds(after.effects)).not.toContain('connect')
  })

  it('ERR_SCHEMA — BLOCKED, документ только читается', () => {
    const r = reduce(liveState(), { t: 'ERR_SCHEMA', at: 5 }, CFG)
    expect(r.state.phase).toBe('blocked')
    expect(r.state.error?.code).toBe('ELM_SCHEMA')
    expect(humanState(r.state)).toBe('attention')
  })

  it('форк цепочки — флаг, а не фаза: работа продолжается', () => {
    const r = reduce(liveState(), { t: 'ERR_CHAIN', at: 5 }, CFG)
    expect(r.state.phase).toBe('live')
    expect(r.state.chainWarning).toBe(true)
    expect(statusOf(r.state, 5).chainWarning).toBe(true)
    expect(humanState(r.state)).toBe('attention')
  })

  it('CLOSE закрывает сокет и просит флаш хвоста', () => {
    const s = { ...liveState(), pending: 2 }
    const r = reduce(s, { t: 'CLOSE', at: 9 }, CFG)
    expect(r.state.phase).toBe('local')
    expect(r.effects).toContainEqual({ e: 'flushHttp', reason: 'pagehide' })
    expect(r.effects).toContainEqual({ e: 'disconnect', reason: 'closed' })
  })
})

describe('автомат синка: статус для человека', () => {
  it('четыре состояния из таблицы §7.3', () => {
    const local = initialState({ phase: 'local' })
    expect(humanState(local)).toBe('offline')
    expect(humanState(initialState({ phase: 'backoff' }))).toBe('offline')
    expect(humanState(initialState({ phase: 'paused' }))).toBe('offline')
    expect(humanState(initialState({ phase: 'live', pending: 3 }))).toBe('syncing')
    expect(humanState(initialState({ phase: 'catchup' }))).toBe('syncing')
    expect(humanState(initialState({ phase: 'live', pending: 0 }))).toBe('together')
    expect(humanState(initialState({ phase: 'denied' }))).toBe('attention')
  })

  it('retryInMs считается от переданного «сейчас»', () => {
    const s = initialState({ phase: 'backoff', retryAt: 5_000 })
    expect(statusOf(s, 1_000).retryInMs).toBe(4_000)
    expect(statusOf(s, 9_000).retryInMs).toBe(0)
    expect(statusOf(initialState(), 0).retryInMs).toBeNull()
  })

  it('редьюсер не мутирует переданное состояние', () => {
    const s = initialState({ phase: 'live', pending: 1 })
    const copy = JSON.parse(JSON.stringify(s)) as unknown
    reduce(s, { t: 'LOCAL_OP', at: 1, count: 5 }, CFG)
    expect(JSON.parse(JSON.stringify(s))).toEqual(copy)
  })
})
