/**
 * LimiterDO (§9.2): два раздельных бакета на префикс. Штраф за перебор живёт в miss-бакете
 * и физически не может заблокировать запрос с валидной подписью — auth-бакет он не трогает.
 * Состояние в памяти, снапшот в ctx.storage по alarm раз в 10 с, выселение записей,
 * не тронутых 15 минут.
 */
import { BUCKETS, C, missCost } from '@elementar/proto'
import type { Env } from '../env.js'

/** Внутренние окна лимитера: в приложении Б их нет, в §9.2 они заданы прозой. */
const MISS_DECAY_MS = 30 * 60_000 // 30 минут без промахов → streak = 0
const MISS_WINDOW_MS = 10 * 60_000 // окно накопления missStreak до блока
const SWEEP_IDLE_MS = 15 * 60_000 // выселение нетронутых записей
const SNAPSHOT_MS = 10_000 // периодичность снапшота в storage
const CREATE_HOUR_LIMIT = 5 // §9.7: 5 документов в час
const CREATE_DAY_LIMIT = 20 // §9.7: 20 документов в сутки
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface Bucket {
  tokens: number
  lastRefill: number
}

export interface PrefixState {
  auth: Bucket
  miss: Bucket
  missStreak: number
  lastMissAt: number
  missWindowStart: number
  strikes: number
  challengeUntil: number
  blockedUntil: number
  createHour: { count: number; since: number }
  createDay: { count: number; since: number }
  touchedAt: number
}

export type LimiterKind = 'auth' | 'anon' | 'miss'

export interface LimiterAsk {
  kind: LimiterKind
  /** Для 'auth' и 'anon' — цена операции; для 'miss' игнорируется (цена = missCost(streak)). */
  cost?: number
  /**
   * Ключ жёсткого блока: IPv4 — полный адрес, IPv6 — /64 (§9.2, §9.8). Бакеты и челлендж
   * живут на более широком префиксе, блок — только на этом ключе. Оба ключа попадают
   * в один шард, потому что шард выбирается по префиксу челленджа.
   */
  blockKey?: string
}

export type LimiterReason = 'rate' | 'challenge' | 'blocked'

export interface LimiterDecision {
  ok: boolean
  reason?: LimiterReason
  /** Секунды. */
  retryAfter?: number
  /** Требуется ли Turnstile для следующих неаутентифицированных запросов. */
  challengeRequired?: boolean
}

const OK: LimiterDecision = { ok: true }

function fresh(now: number): PrefixState {
  return {
    auth: { tokens: BUCKETS.auth.capacity, lastRefill: now },
    miss: { tokens: BUCKETS.miss.capacity, lastRefill: now },
    missStreak: 0,
    lastMissAt: 0,
    missWindowStart: 0,
    strikes: 0,
    challengeUntil: 0,
    blockedUntil: 0,
    createHour: { count: 0, since: now },
    createDay: { count: 0, since: now },
    touchedAt: now,
  }
}

function refill(b: Bucket, capacity: number, perSec: number, now: number): void {
  const dt = Math.max(0, now - b.lastRefill) / 1000
  b.tokens = Math.min(capacity, b.tokens + dt * perSec)
  b.lastRefill = now
}

/** Чистая логика бакетов: без DO, без сети — ровно её и проверяет limiter.test.ts. */
export class LimiterCore {
  private readonly states = new Map<string, PrefixState>()

  constructor(private readonly now: () => number = Date.now) {}

  state(prefix: string): PrefixState {
    const now = this.now()
    let s = this.states.get(prefix)
    if (s === undefined) {
      s = fresh(now)
      this.states.set(prefix, s)
    }
    s.touchedAt = now
    if (s.lastMissAt !== 0 && now - s.lastMissAt > MISS_DECAY_MS) {
      s.missStreak = 0
      s.missWindowStart = 0
    }
    return s
  }

  charge(prefix: string, ask: LimiterAsk): LimiterDecision {
    const now = this.now()
    const s = this.state(prefix)

    if (ask.kind === 'auth') {
      refill(s.auth, BUCKETS.auth.capacity, BUCKETS.auth.refillPerSec, now)
      const cost = Math.max(0, ask.cost ?? 1)
      if (s.auth.tokens < cost) {
        return {
          ok: false,
          reason: 'rate',
          retryAfter: retrySeconds(cost - s.auth.tokens, BUCKETS.auth.refillPerSec),
        }
      }
      s.auth.tokens -= cost
      return OK
    }

    // 'anon' и 'miss' идут в miss-бакет: блок и челлендж применимы только к ним
    const blocks = ask.blockKey === undefined ? s : this.state(ask.blockKey)
    if (blocks.blockedUntil > now) {
      return {
        ok: false,
        reason: 'blocked',
        retryAfter: Math.ceil((blocks.blockedUntil - now) / 1000),
      }
    }
    refill(s.miss, BUCKETS.miss.capacity, BUCKETS.miss.refillPerSec, now)

    if (ask.kind === 'miss') {
      const cost = missCost(s.missStreak)
      s.missStreak += 1
      s.lastMissAt = now
      if (s.missWindowStart === 0 || now - s.missWindowStart > MISS_WINDOW_MS) {
        s.missWindowStart = now
        if (s.missStreak > 1) s.missStreak = 1
      }
      s.miss.tokens = Math.max(0, s.miss.tokens - cost)

      if (s.missStreak >= C.MISS_STREAK_BLOCK) {
        blocks.strikes += 1
        // потолок жёсткого блока — 15 минут, не сутки (§9.2, §9.8)
        blocks.blockedUntil = now + Math.min(2 ** (blocks.strikes - 1) * 60_000, C.BLOCK_MAX_MS)
        s.missStreak = 0
        s.missWindowStart = now
        return {
          ok: false,
          reason: 'blocked',
          retryAfter: Math.ceil((blocks.blockedUntil - now) / 1000),
        }
      }
      if (s.miss.tokens <= 0) {
        s.challengeUntil = now + C.CHALLENGE_MS
        return { ok: false, reason: 'challenge', challengeRequired: true }
      }
      return OK
    }

    // 'anon': плата за неподписанную, но легальную операцию (GET /invite, /challenge)
    if (s.challengeUntil > now) return { ok: false, reason: 'challenge', challengeRequired: true }
    const cost = Math.max(0, ask.cost ?? 1)
    if (s.miss.tokens < cost) {
      s.challengeUntil = now + C.CHALLENGE_MS
      return { ok: false, reason: 'challenge', challengeRequired: true }
    }
    s.miss.tokens -= cost
    return OK
  }

  /** Успешный аутентифицированный ответ снижает missStreak (§9.2 п.4). */
  success(prefix: string): void {
    const s = this.state(prefix)
    s.missStreak = Math.max(0, s.missStreak - 1)
  }

  /** Квота создания документов на префикс (§9.7): 5/час, 20/сутки. */
  createQuota(prefix: string): LimiterDecision {
    const now = this.now()
    const s = this.state(prefix)
    if (now - s.createHour.since >= HOUR_MS) s.createHour = { count: 0, since: now }
    if (now - s.createDay.since >= DAY_MS) s.createDay = { count: 0, since: now }
    if (s.createHour.count >= CREATE_HOUR_LIMIT) {
      return {
        ok: false,
        reason: 'rate',
        retryAfter: Math.ceil((s.createHour.since + HOUR_MS - now) / 1000),
      }
    }
    if (s.createDay.count >= CREATE_DAY_LIMIT) {
      return {
        ok: false,
        reason: 'rate',
        retryAfter: Math.ceil((s.createDay.since + DAY_MS - now) / 1000),
      }
    }
    s.createHour.count += 1
    s.createDay.count += 1
    return OK
  }

  challengeActive(prefix: string): boolean {
    return this.state(prefix).challengeUntil > this.now()
  }

  sweep(): void {
    const now = this.now()
    for (const [k, s] of this.states) {
      if (now - s.touchedAt > SWEEP_IDLE_MS && s.blockedUntil <= now && s.challengeUntil <= now) {
        this.states.delete(k)
      }
    }
  }

  size(): number {
    return this.states.size
  }

  dump(): Array<[string, PrefixState]> {
    return [...this.states]
  }

  load(entries: Array<[string, PrefixState]>): void {
    for (const [k, v] of entries) this.states.set(k, v)
  }
}

function retrySeconds(deficit: number, perSec: number): number {
  return Math.max(1, Math.ceil(deficit / perSec))
}

interface ChargeBody {
  prefix?: unknown
  kind?: unknown
  cost?: unknown
  blockKey?: unknown
}

const STORAGE_KEY = 'states'

export class LimiterDO implements DurableObject {
  private readonly core = new LimiterCore(() => Date.now())
  private loaded = false

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const saved = await this.ctx.storage.get<Array<[string, PrefixState]>>(STORAGE_KEY)
    if (saved !== undefined) this.core.load(saved)
    await this.armAlarm()
  }

  private async armAlarm(): Promise<void> {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null) await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_MS)
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    const url = new URL(request.url)
    let body: ChargeBody = {}
    try {
      body = (await request.json()) as ChargeBody
    } catch {
      return json({ ok: false, reason: 'rate' } satisfies LimiterDecision, 400)
    }
    const prefix = typeof body.prefix === 'string' && body.prefix.length > 0 ? body.prefix : null
    if (prefix === null) return json({ ok: false, reason: 'rate' } satisfies LimiterDecision, 400)

    switch (url.pathname) {
      case '/charge': {
        const kind = body.kind
        if (kind !== 'auth' && kind !== 'anon' && kind !== 'miss') {
          return json({ ok: false, reason: 'rate' } satisfies LimiterDecision, 400)
        }
        const cost = typeof body.cost === 'number' && Number.isFinite(body.cost) ? body.cost : 1
        const blockKey = typeof body.blockKey === 'string' ? body.blockKey : undefined
        const d = this.core.charge(
          prefix,
          blockKey === undefined ? { kind, cost } : { kind, cost, blockKey },
        )
        await this.armAlarm()
        return json(d, 200)
      }
      case '/success':
        this.core.success(prefix)
        return json(OK, 200)
      case '/create': {
        const d = this.core.createQuota(prefix)
        await this.armAlarm()
        return json(d, 200)
      }
      default:
        return json({ ok: false, reason: 'rate' } satisfies LimiterDecision, 404)
    }
  }

  async alarm(): Promise<void> {
    this.core.sweep()
    await this.ctx.storage.put(STORAGE_KEY, this.core.dump())
    if (this.core.size() > 0) await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_MS)
  }
}

function json(v: unknown, status: number): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
