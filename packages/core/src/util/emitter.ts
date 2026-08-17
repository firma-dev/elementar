export type Unsubscribe = () => void

/** Минимальный типизированный эмиттер: карта «событие → полезная нагрузка». */
export class Emitter<E extends Record<string, unknown>> {
  readonly #handlers = new Map<keyof E, Set<(payload: never) => void>>()

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): Unsubscribe {
    let set = this.#handlers.get(event)
    if (!set) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    const wrapped = fn as (payload: never) => void
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }

  once<K extends keyof E>(event: K, fn: (payload: E[K]) => void): Unsubscribe {
    const off = this.on(event, (p) => {
      off()
      fn(p)
    })
    return off
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.#handlers.get(event)
    if (!set) return
    // копия: подписчик может отписаться прямо в обработчике
    for (const fn of [...set]) (fn as (p: E[K]) => void)(payload)
  }

  clear(): void {
    this.#handlers.clear()
  }
}
