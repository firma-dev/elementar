/**
 * Эшелон 1 (§9.3): «этот docId существует / точно не существует» в Cache API — до лимитера
 * и до DocDO. Для неизвестного id DocDO не инстанцируется вообще: ни счёта, ни тайминга.
 */
import { C } from '@elementar/proto'

export interface ExistsCache {
  get(docId: string): Promise<boolean | null>
  set(docId: string, exists: boolean): Promise<void>
}

const KEY_ORIGIN = 'https://exists/'

export class CacheApiExists implements ExistsCache {
  constructor(private readonly cache: Cache) {}

  async get(docId: string): Promise<boolean | null> {
    const hit = await this.cache.match(new Request(KEY_ORIGIN + docId))
    if (hit === undefined) return null
    const body = await hit.text()
    return body === '1'
  }

  async set(docId: string, exists: boolean): Promise<void> {
    const maxAge = exists ? C.EXISTS_CACHE_POS_S : C.EXISTS_CACHE_NEG_S
    await this.cache.put(
      new Request(KEY_ORIGIN + docId),
      new Response(exists ? '1' : '0', {
        headers: { 'cache-control': `max-age=${maxAge}`, 'content-type': 'text/plain' },
      }),
    )
  }
}

/**
 * Состояние наказания префикса (§9.3): держится в Cache API, чтобы повторный мусор
 * не стоил даже запроса к LimiterDO.
 */
export interface PenaltyState {
  challengeUntil: number
  blockedUntil: number
}

export interface PenaltyCache {
  get(key: string): Promise<PenaltyState | null>
  set(key: string, state: PenaltyState): Promise<void>
}

const PENALTY_ORIGIN = 'https://penalty/'

export class CacheApiPenalty implements PenaltyCache {
  constructor(
    private readonly cache: Cache,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<PenaltyState | null> {
    const hit = await this.cache.match(new Request(PENALTY_ORIGIN + key))
    if (hit === undefined) return null
    try {
      return (await hit.json()) as PenaltyState
    } catch {
      return null
    }
  }

  async set(key: string, state: PenaltyState): Promise<void> {
    const ttl = Math.ceil((Math.max(state.challengeUntil, state.blockedUntil) - this.now()) / 1000)
    if (ttl <= 0) return
    await this.cache.put(
      new Request(PENALTY_ORIGIN + key),
      new Response(JSON.stringify(state), {
        headers: { 'cache-control': `max-age=${ttl}`, 'content-type': 'application/json' },
      }),
    )
  }
}

export class MemoryPenalty implements PenaltyCache {
  private readonly map = new Map<string, PenaltyState>()
  async get(key: string): Promise<PenaltyState | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, state: PenaltyState): Promise<void> {
    this.map.set(key, state)
  }
}

/** Память вместо Cache API — для dev-рантайма без caches и для тестов. */
export class MemoryExists implements ExistsCache {
  private readonly map = new Map<string, { v: boolean; until: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  async get(docId: string): Promise<boolean | null> {
    const e = this.map.get(docId)
    if (e === undefined) return null
    if (e.until <= this.now()) {
      this.map.delete(docId)
      return null
    }
    return e.v
  }

  async set(docId: string, exists: boolean): Promise<void> {
    const ttl = (exists ? C.EXISTS_CACHE_POS_S : C.EXISTS_CACHE_NEG_S) * 1000
    this.map.set(docId, { v: exists, until: this.now() + ttl })
  }
}
