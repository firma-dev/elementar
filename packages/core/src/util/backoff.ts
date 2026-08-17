import { BACKOFF_STEPS_MS, C } from '@elementar/proto'

/**
 * Шаги переподключения (§7.4): фиксированная лестница из протокола,
 * потолок `BACKOFF_MAX_MS`, джиттер ±30 %.
 */
export function backoffDelay(attempt: number, rnd: () => number = Math.random): number {
  const i = Math.max(0, Math.min(BACKOFF_STEPS_MS.length - 1, Math.floor(attempt)))
  const base = Math.min(BACKOFF_STEPS_MS[i] as number, C.BACKOFF_MAX_MS)
  const jitter = 1 + (rnd() * 2 - 1) * C.BACKOFF_JITTER
  return Math.max(0, Math.round(base * jitter))
}

export class Backoff {
  #attempt = 0
  constructor(private readonly rnd: () => number = Math.random) {}

  get attempt(): number {
    return this.#attempt
  }

  /** Следующая пауза; счётчик растёт до конца лестницы. */
  next(): number {
    const d = backoffDelay(this.#attempt, this.rnd)
    if (this.#attempt < BACKOFF_STEPS_MS.length - 1) this.#attempt++
    return d
  }

  reset(): void {
    this.#attempt = 0
  }
}
