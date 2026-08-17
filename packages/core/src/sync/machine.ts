/**
 * Конечный автомат синка (§7.3). Чистая функция `reduce(state, event) → [state, Effect[]]`:
 * никакого ввода-вывода, никаких таймеров, никакого Date.now — время приходит в событии.
 * Эффекты исполняет `session.ts`, поэтому автомат тестируется без сети.
 */
import { C } from '@elementar/proto'
import type { ElmErrorCode } from '@elementar/proto'
import { backoffDelay } from '../util/backoff.js'

export type SyncPhase =
  | 'loading'
  | 'local'
  | 'connecting'
  | 'catchup'
  | 'live'
  | 'backoff'
  | 'paused'
  | 'denied'
  | 'blocked'

/** Коды ошибок синка: серверные из протокола плюс два локальных. */
export type SyncErrorCode = ElmErrorCode | 'ELM_NETWORK' | 'ELM_CHAIN' | 'ELM_SCHEMA'

export interface SyncStatus {
  phase: SyncPhase
  online: boolean
  /** Операций в outbox. */
  pending: number
  lastSyncedAt: number | null
  peers: number
  retryInMs: number | null
  /** Расхождение хеш-цепочки с пиром (§6.11). */
  chainWarning: boolean
  error: { code: SyncErrorCode; message: string } | null
}

// ——— события ———

export interface EventBase {
  /** Момент события в мс. Единственный источник времени для автомата. */
  at: number
}

export type SyncEvent =
  | (EventBase & { t: 'OPEN'; sync?: boolean; online?: boolean; visible?: boolean })
  | (EventBase & { t: 'LOADED'; since: number; pending: number })
  | (EventBase & { t: 'ENABLE_SYNC' })
  | (EventBase & { t: 'DISABLE_SYNC' })
  | (EventBase & { t: 'NET_ONLINE' })
  | (EventBase & { t: 'NET_OFFLINE' })
  | (EventBase & { t: 'SOCK_OPEN' })
  | (EventBase & { t: 'SOCK_CLOSE'; code?: number })
  | (EventBase & {
      t: 'WELCOME'
      head: number
      snapshotSeq: number
      peers: number
      compactionNeeded: boolean
      safeCompactSeq: number
    })
  | (EventBase & { t: 'OPS'; count: number; upto: number; more?: boolean })
  | (EventBase & {
      t: 'ACK'
      /** Сколько элементов очереди закрыто этим ack (включая дубликаты). */
      acked: number
      head: number
      /** Точный остаток очереди, если вызывающий его знает. */
      pending?: number
    })
  | (EventBase & { t: 'LOCAL_OP'; count?: number })
  | (EventBase & { t: 'DRAINED' })
  | (EventBase & { t: 'TIMER' })
  | (EventBase & { t: 'HIDDEN' })
  | (EventBase & { t: 'VISIBLE' })
  | (EventBase & { t: 'PAGEHIDE' })
  | (EventBase & { t: 'ERR_AUTH'; message?: string })
  | (EventBase & { t: 'ERR_RATE'; retryAfterMs?: number; message?: string })
  | (EventBase & { t: 'ERR_SCHEMA'; message?: string })
  | (EventBase & { t: 'ERR_CHAIN'; message?: string })
  | (EventBase & { t: 'ERR_OTHER'; code?: SyncErrorCode; message?: string })
  | (EventBase & { t: 'CLOSE' })

export type SyncEventType = SyncEvent['t']

// ——— эффекты ———

export type Effect =
  | { e: 'connect'; since: number }
  | { e: 'disconnect'; reason: 'paused' | 'offline' | 'closed' | 'sync-off' | 'error' }
  /** Отправить хвост очереди (WS или HTTP — решает session). */
  | { e: 'send'; since: number }
  /** Взвести единственный таймер автомата; предыдущий отменяется. */
  | { e: 'schedule'; at: number; reason: 'backoff' | 'hidden' | 'hold' }
  | { e: 'cancel' }
  | { e: 'persist'; what: 'status' | 'seq' }
  /** Флаш outbox через fetch(keepalive) — §7.5. */
  | { e: 'flushHttp'; reason: 'pagehide' | 'hidden' | 'paused' | 'offline' }
  /** Локальное состояние отстало от серверного снапшота: забрать снапшот по HTTP. */
  | { e: 'resync'; snapshotSeq: number }
  /** Показать сводку «пока вас не было» (§6.12). */
  | { e: 'digest'; applied: number }

export interface Reduction {
  state: MachineState
  effects: Effect[]
}

export interface MachineState {
  phase: SyncPhase
  online: boolean
  syncEnabled: boolean
  visible: boolean
  pending: number
  /** Последний применённый серверный seq. */
  since: number
  /** Серверная голова лога. */
  head: number
  peers: number
  lastSyncedAt: number | null
  /** Номер попытки переподключения для лестницы бэкоффа. */
  attempt: number
  retryAt: number | null
  chainWarning: boolean
  compactionNeeded: boolean
  safeCompactSeq: number
  /** Момент, с которого соединение держится: n сбрасывается через 30 с (§7.4). */
  holdUntil: number | null
  hiddenSince: number | null
  /** Чужих операций применено с начала CATCHUP — порог сводки (§6.12). */
  catchupApplied: number
  timer: { at: number; reason: 'backoff' | 'hidden' | 'hold' } | null
  error: { code: SyncErrorCode; message: string } | null
}

export interface ReduceConfig {
  /** Источник джиттера бэкоффа; в тестах — фиксированный. */
  rnd?: () => number
}

/** Держим соединение столько — и счётчик попыток можно обнулить (§7.4). */
export const HOLD_MS = 30_000

export function initialState(patch: Partial<MachineState> = {}): MachineState {
  return {
    phase: 'loading',
    online: true,
    syncEnabled: true,
    visible: true,
    pending: 0,
    since: 0,
    head: 0,
    peers: 0,
    lastSyncedAt: null,
    attempt: 0,
    retryAt: null,
    chainWarning: false,
    compactionNeeded: false,
    safeCompactSeq: 0,
    holdUntil: null,
    hiddenSince: null,
    catchupApplied: 0,
    timer: null,
    error: null,
    ...patch,
  }
}

export function statusOf(s: MachineState, now: number = Date.now()): SyncStatus {
  return {
    phase: s.phase,
    online: s.online,
    pending: s.pending,
    lastSyncedAt: s.lastSyncedAt,
    peers: s.peers,
    retryInMs: s.retryAt === null ? null : Math.max(0, s.retryAt - now),
    chainWarning: s.chainWarning,
    error: s.error,
  }
}

/** Четыре слова для человека (§7.3). */
export type HumanState = 'offline' | 'syncing' | 'together' | 'attention'

export function humanState(s: MachineState): HumanState {
  if (s.phase === 'denied' || s.phase === 'blocked' || s.chainWarning) return 'attention'
  if (s.phase === 'live' && s.pending === 0) return 'together'
  if (s.phase === 'connecting' || s.phase === 'catchup' || s.phase === 'live') return 'syncing'
  return 'offline'
}

/** Терминальные фазы: из них выводит только повторное открытие документа. */
export function isTerminal(phase: SyncPhase): boolean {
  return phase === 'denied' || phase === 'blocked'
}

const CONNECTED: readonly SyncPhase[] = ['connecting', 'catchup', 'live']

function connected(phase: SyncPhase): boolean {
  return CONNECTED.includes(phase)
}

function schedule(
  s: MachineState,
  at: number,
  reason: 'backoff' | 'hidden' | 'hold',
  effects: Effect[],
): MachineState {
  effects.push({ e: 'schedule', at, reason })
  return { ...s, timer: { at, reason } }
}

/** Уход в бэкофф: единая точка для разрыва, ошибки и лимита. */
function toBackoff(
  s: MachineState,
  at: number,
  effects: Effect[],
  cfg: ReduceConfig,
  opts: { delayMs?: number; error?: { code: SyncErrorCode; message: string } } = {},
): MachineState {
  const attempt = s.attempt
  const delay = opts.delayMs ?? backoffDelay(attempt, cfg.rnd ?? Math.random)
  const retryAt = at + delay
  const next: MachineState = {
    ...s,
    phase: 'backoff',
    attempt: Math.min(attempt + 1, 64),
    retryAt,
    holdUntil: null,
    peers: 0,
    error: opts.error ?? s.error,
  }
  return schedule(next, retryAt, 'backoff', effects)
}

function toConnecting(s: MachineState, effects: Effect[]): MachineState {
  effects.push({ e: 'cancel' })
  effects.push({ e: 'connect', since: s.since })
  return { ...s, phase: 'connecting', retryAt: null, timer: null, catchupApplied: 0 }
}

/** Куда падать, когда сеть или синк выключены. */
function toLocal(s: MachineState, effects: Effect[], reason: 'offline' | 'sync-off'): MachineState {
  if (connected(s.phase)) effects.push({ e: 'disconnect', reason })
  effects.push({ e: 'cancel' })
  return {
    ...s,
    phase: 'local',
    retryAt: null,
    timer: null,
    peers: 0,
    holdUntil: null,
    hiddenSince: null,
  }
}

function canConnect(s: MachineState): boolean {
  return s.syncEnabled && s.online && !isTerminal(s.phase)
}

export function reduce(state: MachineState, event: SyncEvent, cfg: ReduceConfig = {}): Reduction {
  const effects: Effect[] = []
  let s = state

  switch (event.t) {
    case 'OPEN': {
      s = {
        ...s,
        phase: 'loading',
        syncEnabled: event.sync ?? s.syncEnabled,
        online: event.online ?? s.online,
        visible: event.visible ?? s.visible,
        error: null,
      }
      break
    }

    case 'LOADED': {
      s = { ...s, since: event.since, pending: event.pending }
      if (s.phase !== 'loading') break
      s = canConnect(s) ? toConnecting(s, effects) : { ...s, phase: 'local' }
      break
    }

    case 'ENABLE_SYNC': {
      if (s.syncEnabled) break
      s = { ...s, syncEnabled: true, attempt: 0 }
      if (!isTerminal(s.phase) && s.online && s.phase !== 'loading') s = toConnecting(s, effects)
      break
    }

    case 'DISABLE_SYNC': {
      if (!s.syncEnabled) break
      s = toLocal({ ...s, syncEnabled: false }, effects, 'sync-off')
      break
    }

    case 'NET_OFFLINE': {
      if (!s.online) break
      if (s.pending > 0) effects.push({ e: 'flushHttp', reason: 'offline' })
      s = toLocal({ ...s, online: false }, effects, 'offline')
      break
    }

    case 'NET_ONLINE': {
      if (s.online && connected(s.phase)) break
      s = { ...s, online: true, attempt: 0 }
      if (isTerminal(s.phase) || !s.syncEnabled || s.phase === 'loading') break
      // немедленная попытка только при видимой вкладке (§7.4)
      if (s.visible) s = toConnecting(s, effects)
      else if (s.phase !== 'paused') s = { ...s, phase: 'local' }
      break
    }

    case 'SOCK_OPEN': {
      if (s.phase !== 'connecting') break
      // фаза не меняется: соединение живо, но до welcome мы ничего о нём не знаем
      break
    }

    case 'WELCOME': {
      if (!connected(s.phase)) break
      const behind = event.snapshotSeq > s.since
      s = {
        ...s,
        phase: 'catchup',
        head: event.head,
        peers: event.peers,
        compactionNeeded: event.compactionNeeded,
        safeCompactSeq: event.safeCompactSeq,
        holdUntil: event.at + HOLD_MS,
        catchupApplied: 0,
        error: null,
      }
      s = schedule(s, event.at + HOLD_MS, 'hold', effects)
      if (behind) {
        effects.push({ e: 'resync', snapshotSeq: event.snapshotSeq })
        break
      }
      if (s.pending > 0) effects.push({ e: 'send', since: s.since })
      if (event.head <= s.since) {
        s = { ...s, phase: 'live', lastSyncedAt: event.at }
        effects.push({ e: 'persist', what: 'status' })
      }
      break
    }

    case 'OPS': {
      if (!connected(s.phase)) break
      s = {
        ...s,
        since: Math.max(s.since, event.upto),
        head: Math.max(s.head, event.upto),
        lastSyncedAt: event.at,
        catchupApplied: s.phase === 'catchup' ? s.catchupApplied + event.count : s.catchupApplied,
      }
      effects.push({ e: 'persist', what: 'seq' })
      break
    }

    case 'DRAINED': {
      if (s.phase !== 'catchup') break
      s = { ...s, phase: 'live', lastSyncedAt: event.at }
      if (s.catchupApplied > C.DIGEST_THRESHOLD) {
        effects.push({ e: 'digest', applied: s.catchupApplied })
      }
      if (s.pending > 0) effects.push({ e: 'send', since: s.since })
      effects.push({ e: 'persist', what: 'status' })
      break
    }

    case 'ACK': {
      const pending = event.pending ?? Math.max(0, s.pending - event.acked)
      s = { ...s, pending, head: Math.max(s.head, event.head), lastSyncedAt: event.at }
      effects.push({ e: 'persist', what: 'status' })
      break
    }

    case 'LOCAL_OP': {
      s = { ...s, pending: s.pending + Math.max(1, event.count ?? 1) }
      if (s.phase === 'live' || s.phase === 'catchup') effects.push({ e: 'send', since: s.since })
      break
    }

    case 'TIMER': {
      const timer = s.timer
      if (timer === null || event.at < timer.at) break
      s = { ...s, timer: null }
      if (timer.reason === 'backoff') {
        if (canConnect(s)) s = toConnecting(s, effects)
        else s = { ...s, phase: s.online ? s.phase : 'local', retryAt: null }
        break
      }
      if (timer.reason === 'hold') {
        // соединение прожило 30 с — лестница бэкоффа начинается заново
        if (connected(s.phase)) s = { ...s, attempt: 0, holdUntil: null }
        break
      }
      // hidden: вкладка скрыта дольше минуты — сокет закрывается, экономия батареи
      if (s.hiddenSince !== null && !s.visible && connected(s.phase)) {
        if (s.pending > 0) effects.push({ e: 'flushHttp', reason: 'paused' })
        effects.push({ e: 'disconnect', reason: 'paused' })
        s = { ...s, phase: 'paused', peers: 0, holdUntil: null, retryAt: null }
      }
      break
    }

    case 'HIDDEN': {
      if (!s.visible) break
      s = { ...s, visible: false, hiddenSince: event.at }
      if (s.pending > 0) effects.push({ e: 'flushHttp', reason: 'hidden' })
      if (connected(s.phase)) s = schedule(s, event.at + C.HIDDEN_DISCONNECT_MS, 'hidden', effects)
      break
    }

    case 'VISIBLE': {
      if (s.visible) break
      s = { ...s, visible: true, hiddenSince: null }
      if (s.timer?.reason === 'hidden') {
        effects.push({ e: 'cancel' })
        s = { ...s, timer: null }
      }
      if (s.phase === 'paused' && canConnect(s)) {
        s = { ...s, attempt: 0 }
        s = toConnecting(s, effects)
      }
      break
    }

    case 'PAGEHIDE': {
      if (s.pending > 0) effects.push({ e: 'flushHttp', reason: 'pagehide' })
      break
    }

    case 'ERR_AUTH': {
      if (connected(s.phase)) effects.push({ e: 'disconnect', reason: 'error' })
      effects.push({ e: 'cancel' })
      s = {
        ...s,
        phase: 'denied',
        timer: null,
        retryAt: null,
        peers: 0,
        error: { code: 'ELM_NOT_FOUND', message: event.message ?? 'Документ недоступен' },
      }
      break
    }

    case 'ERR_SCHEMA': {
      if (connected(s.phase)) effects.push({ e: 'disconnect', reason: 'error' })
      effects.push({ e: 'cancel' })
      s = {
        ...s,
        phase: 'blocked',
        timer: null,
        retryAt: null,
        peers: 0,
        error: { code: 'ELM_SCHEMA', message: event.message ?? 'Документ новее приложения' },
      }
      break
    }

    case 'ERR_CHAIN': {
      // форк — не фаза, а флаг: работа продолжается, но с громким баннером (§6.11)
      s = {
        ...s,
        chainWarning: true,
        error: { code: 'ELM_CHAIN', message: event.message ?? 'Сервер отдаёт неполную историю' },
      }
      effects.push({ e: 'persist', what: 'status' })
      break
    }

    case 'ERR_RATE': {
      if (connected(s.phase)) effects.push({ e: 'disconnect', reason: 'error' })
      s = toBackoff(s, event.at, effects, cfg, {
        ...(event.retryAfterMs === undefined ? {} : { delayMs: event.retryAfterMs }),
        error: { code: 'ELM_RATE_LIMITED', message: event.message ?? 'Слишком часто' },
      })
      break
    }

    case 'ERR_OTHER': {
      if (isTerminal(s.phase)) break
      if (connected(s.phase)) effects.push({ e: 'disconnect', reason: 'error' })
      if (!s.online || !s.syncEnabled) {
        s = toLocal(s, effects, 'offline')
        break
      }
      s = toBackoff(s, event.at, effects, cfg, {
        error: { code: event.code ?? 'ELM_INTERNAL', message: event.message ?? 'Ошибка синка' },
      })
      break
    }

    case 'SOCK_CLOSE': {
      if (isTerminal(s.phase) || s.phase === 'paused') break
      if (!canConnect(s)) {
        s = toLocal(s, effects, s.online ? 'sync-off' : 'offline')
        break
      }
      s = toBackoff(s, event.at, effects, cfg, {
        error: { code: 'ELM_NETWORK', message: 'Соединение потеряно' },
      })
      break
    }

    case 'CLOSE': {
      if (s.pending > 0) effects.push({ e: 'flushHttp', reason: 'pagehide' })
      if (connected(s.phase)) effects.push({ e: 'disconnect', reason: 'closed' })
      effects.push({ e: 'cancel' })
      s = { ...s, phase: 'local', timer: null, retryAt: null, peers: 0, holdUntil: null }
      break
    }
  }

  return { state: s, effects }
}

/** Прогон списка событий: удобно и в тестах, и в session при разборе пачки. */
export function reduceAll(
  state: MachineState,
  events: readonly SyncEvent[],
  cfg: ReduceConfig = {},
): Reduction {
  let s = state
  const effects: Effect[] = []
  for (const e of events) {
    const r = reduce(s, e, cfg)
    s = r.state
    effects.push(...r.effects)
  }
  return { state: s, effects }
}
