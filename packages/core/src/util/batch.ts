/** Дебаунс, троттлинг и нарезка — то, чем пользуются view и sync. */

export interface Debounced<A extends unknown[]> {
  (...args: A): void
  flush(): void
  cancel(): void
  readonly pending: boolean
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: A | null = null
  const run = (): void => {
    timer = null
    const args = last
    last = null
    if (args) fn(...args)
  }
  const d = ((...args: A): void => {
    last = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(run, ms)
  }) as Debounced<A>
  Object.defineProperty(d, 'pending', { get: () => timer !== null })
  d.flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      run()
    }
  }
  d.cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    last = null
  }
  return d
}

/** Копит вызовы до конца микротаска, затем отдаёт всё разом. */
export function microtaskBatch<T>(sink: (items: T[]) => void): (item: T) => void {
  let queue: T[] | null = null
  return (item: T): void => {
    if (queue === null) {
      queue = [item]
      const q = queue
      queueMicrotask(() => {
        queue = null
        sink(q)
      })
    } else {
      queue.push(item)
    }
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Нарезка по суммарному «весу» — пачки операций под лимит байт. */
export function chunkByWeight<T>(items: readonly T[], maxWeight: number, weight: (t: T) => number): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let w = 0
  for (const it of items) {
    const iw = weight(it)
    if (cur.length > 0 && w + iw > maxWeight) {
      out.push(cur)
      cur = []
      w = 0
    }
    cur.push(it)
    w += iw
  }
  if (cur.length > 0) out.push(cur)
  return out
}
