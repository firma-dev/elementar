/** Доступ к LimiterDO из Worker'а. В тестах подменяется на LimiterCore напрямую. */
import { shardName } from './ipHash.js'
import type { LimiterAsk, LimiterDecision } from '../do/limiter.js'
import { LimiterCore } from '../do/limiter.js'

export interface LimiterClient {
  charge(prefixHash: string, ask: LimiterAsk): Promise<LimiterDecision>
  success(prefixHash: string): Promise<void>
  createQuota(prefixHash: string): Promise<LimiterDecision>
}

const OK: LimiterDecision = { ok: true }

export class DoLimiter implements LimiterClient {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(prefixHash: string): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(shardName(prefixHash)))
  }

  private async call(
    prefixHash: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<LimiterDecision> {
    try {
      const res = await this.stub(prefixHash).fetch(`https://limiter${path}`, {
        method: 'POST',
        body: JSON.stringify({ prefix: prefixHash, ...body }),
      })
      const d = (await res.json()) as LimiterDecision
      return typeof d.ok === 'boolean' ? d : OK
    } catch {
      // лимитер недоступен — пропускаем запрос: терять работоспособность из-за счётчика нельзя
      return OK
    }
  }

  charge(prefixHash: string, ask: LimiterAsk): Promise<LimiterDecision> {
    return this.call(prefixHash, '/charge', {
      kind: ask.kind,
      cost: ask.cost ?? 1,
      blockKey: ask.blockKey ?? null,
    })
  }

  async success(prefixHash: string): Promise<void> {
    await this.call(prefixHash, '/success', {})
  }

  createQuota(prefixHash: string): Promise<LimiterDecision> {
    return this.call(prefixHash, '/create', {})
  }
}

/** Локальный лимитер в памяти изолята — для dev и тестов. */
export class LocalLimiter implements LimiterClient {
  readonly core: LimiterCore
  constructor(now: () => number = Date.now) {
    this.core = new LimiterCore(now)
  }
  async charge(prefixHash: string, ask: LimiterAsk): Promise<LimiterDecision> {
    return this.core.charge(prefixHash, ask)
  }
  async success(prefixHash: string): Promise<void> {
    this.core.success(prefixHash)
  }
  async createQuota(prefixHash: string): Promise<LimiterDecision> {
    return this.core.createQuota(prefixHash)
  }
}
