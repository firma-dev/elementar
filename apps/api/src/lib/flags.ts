/**
 * Рубильники (§8.2). Источник истины — D1, горячее чтение — KV с cacheTtl 60:
 * на горячем пути в среднем ноль запросов, рубильник действует за 60 секунд.
 */
export interface Flags {
  acceptCreates: boolean
  acceptWrites: boolean
  llmRelay: boolean
  /** 0 авто, 1 всегда Turnstile, 2 никогда. */
  challengeMode: 0 | 1 | 2
}

export const DEFAULT_FLAGS: Flags = {
  acceptCreates: true,
  acceptWrites: true,
  llmRelay: true,
  challengeMode: 0,
}

export const FLAG_KEYS = ['accept_creates', 'accept_writes', 'llm_relay', 'challenge_mode'] as const

export function flagsFromRecord(rec: Record<string, string>): Flags {
  const mode = Number(rec['challenge_mode'] ?? '0')
  return {
    acceptCreates: (rec['accept_creates'] ?? '1') === '1',
    acceptWrites: (rec['accept_writes'] ?? '1') === '1',
    llmRelay: (rec['llm_relay'] ?? '1') === '1',
    challengeMode: mode === 1 ? 1 : mode === 2 ? 2 : 0,
  }
}

export interface FlagsReader {
  read(): Promise<Flags>
}

export class KvFlags implements FlagsReader {
  constructor(private readonly kv: KVNamespace) {}

  async read(): Promise<Flags> {
    const raw = await this.kv.get('flags', { type: 'json', cacheTtl: 60 })
    if (raw === null || typeof raw !== 'object') return DEFAULT_FLAGS
    const rec: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) rec[k] = String(v)
    return flagsFromRecord(rec)
  }
}
