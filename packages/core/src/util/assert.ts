/** Инварианты ядра. Бросаем только на ошибках программиста, не на данных из сети. */

export class AssertError extends Error {
  override readonly name = 'AssertError'
  constructor(message: string) {
    super(message)
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertError(message)
}

export function assertDefined<T>(v: T | null | undefined, message: string): T {
  if (v === null || v === undefined) throw new AssertError(message)
  return v
}

/** Проверка полноты switch по union. */
export function unreachable(v: never, message = 'недостижимая ветка'): never {
  throw new AssertError(`${message}: ${JSON.stringify(v)}`)
}
