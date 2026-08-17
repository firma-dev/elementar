import type { FetchLike } from '../types.js'

export interface ProviderDeps {
  fetch?: FetchLike
  /** Одноразовый Turnstile-токен: нужен только режиму 'elm-relay' (§10.2 п.3). */
  challenge?(): string | null
}
