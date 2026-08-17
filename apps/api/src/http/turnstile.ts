/**
 * Turnstile — эскалация под атакой вместо PoW (§9.7). Работает без аккаунтов;
 * секрет живёт только в env, токен пользователя нигде не сохраняется.
 */
export interface TurnstileVerifier {
  sitekey(): string
  verify(token: string | null): Promise<boolean>
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export class CloudflareTurnstile implements TurnstileVerifier {
  constructor(
    private readonly secret: string,
    private readonly siteKey: string,
  ) {}

  sitekey(): string {
    return this.siteKey
  }

  async verify(token: string | null): Promise<boolean> {
    if (token === null || token.length === 0 || token.length > 2048) return false
    if (this.secret === '') return false
    try {
      const res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // remoteip намеренно не передаём: сырой IP не покидает Worker (§8.2)
        body: new URLSearchParams({ secret: this.secret, response: token }).toString(),
      })
      if (!res.ok) return false
      const body = (await res.json()) as { success?: unknown }
      return body.success === true
    } catch {
      return false
    }
  }
}

/** Заглушка для dev и тестов: секрет не настроен — челлендж не выдаётся и не требуется. */
export class DisabledTurnstile implements TurnstileVerifier {
  sitekey(): string {
    return ''
  }
  async verify(): Promise<boolean> {
    return false
  }
}
