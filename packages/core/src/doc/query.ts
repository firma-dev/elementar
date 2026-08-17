export type WhereOp<V> = V | { in: V[] } | { not: V } | { gte: V } | { lte: V }

export type Where<T> = Partial<{ [K in keyof T]: WhereOp<T[K]> }> & {
  $order?: { by: keyof T; dir?: 'asc' | 'desc' }
  $limit?: number
  $search?: string
}

function isOpObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && ['in', 'not', 'gte', 'lte'].includes(keys[0] as string)
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return false
}

/** Сравнение для gte/lte: числа, строки, булевы; несравнимое считается равным. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1
  if (b === null || b === undefined) return 1
  return 0
}

function matchField(value: unknown, cond: unknown): boolean {
  if (isOpObject(cond)) {
    if ('in' in cond) {
      const list = cond['in']
      return Array.isArray(list) && list.some((x) => eq(value, x))
    }
    if ('not' in cond) return !eq(value, cond['not'])
    if ('gte' in cond) return compareValues(value, cond['gte']) >= 0
    if ('lte' in cond) return compareValues(value, cond['lte']) <= 0
  }
  return eq(value, cond)
}

function searchHit(rec: Record<string, unknown>, needle: string): boolean {
  const q = needle.trim().toLowerCase()
  if (q === '') return true
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.toLowerCase().includes(q))) return true
  }
  return false
}

export function matchesWhere<T extends object>(rec: T, spec: Where<T>): boolean {
  for (const [key, cond] of Object.entries(spec)) {
    if (key.startsWith('$')) continue
    if (!matchField((rec as Record<string, unknown>)[key], cond)) return false
  }
  const search = spec.$search
  if (typeof search === 'string' && !searchHit(rec as Record<string, unknown>, search)) return false
  return true
}

/** Фильтр + сортировка + лимит. Порядок по умолчанию — тот, в котором пришли записи. */
export function runQuery<T extends object>(records: readonly T[], spec: Where<T>): T[] {
  let out = records.filter((r) => matchesWhere(r, spec))
  const order = spec.$order
  if (order !== undefined) {
    const dir = order.dir === 'desc' ? -1 : 1
    const by = order.by as string
    out = [...out].sort(
      (a, b) => dir * compareValues((a as Record<string, unknown>)[by], (b as Record<string, unknown>)[by]),
    )
  }
  const limit = spec.$limit
  if (typeof limit === 'number' && limit >= 0) out = out.slice(0, limit)
  return out
}

/** Стабильный ключ запроса для кеша сигналов. */
export function queryKey<T>(spec: Where<T>): string {
  const keys = Object.keys(spec).sort()
  const parts = keys.map((k) => `${k}=${JSON.stringify((spec as Record<string, unknown>)[k])}`)
  return parts.join('&')
}
