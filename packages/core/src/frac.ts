import { BASE62 } from './id.js'
import type { ActorId, RecordId } from './id.js'

/** Дробный индекс base62 + '#' + actorId (§6.4). */
export type OrderKey = string

/** Разделитель меньше любой цифры алфавита: 'V#a' < 'V0#a'. */
export const ORDER_SEP = '#'
/** Порог перестройки группы: ключи длиннее — сигнал к ребалансу. */
export const REBALANCE_LEN = 48

const D = BASE62
const RADIX = D.length

function idx(ch: string): number {
  const i = D.indexOf(ch)
  return i < 0 ? 0 : i
}

/** Часть ключа до '#'. Хвост нулей отбрасывается: как дробь '0V0' === '0V'. */
export function orderDigits(key: OrderKey | null | undefined): string | null {
  if (key === null || key === undefined) return null
  const cut = key.indexOf(ORDER_SEP)
  let d = cut < 0 ? key : key.slice(0, cut)
  let end = d.length
  while (end > 0 && d[end - 1] === '0') end--
  d = d.slice(0, end)
  for (let i = 0; i < d.length; i++) if (D.indexOf(d[i] as string) < 0) return null
  return d
}

export function orderActor(key: OrderKey): ActorId {
  const cut = key.indexOf(ORDER_SEP)
  return cut < 0 ? '' : key.slice(cut + 1)
}

/**
 * Строка цифр, строго между `a` и `b` как дробями в (0,1).
 * `a === ''` — нижняя граница, `b === null` — верхняя. Хвостовых нулей не порождает.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while (n < b.length && (a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a.length > 0 ? idx(a[0] as string) : 0
  const db = b !== null && b.length > 0 ? idx(b[0] as string) : RADIX
  if (db - da > 1) return D[Math.round(0.5 * (da + db))] as string
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return (D[da] as string) + midpoint(a.slice(1), null)
}

/**
 * Ключ строго между соседями. К каждому ключу приписан actorId: два клиента,
 * вставившие офлайн «между теми же соседями», получают разные ключи и оба выживают.
 *
 * Вставить что-либо между двумя ключами с одинаковой цифровой частью нельзя
 * (за неё отвечает только actorId) — в этом случае ключ ставится после `a`;
 * позиционирование внутри такой пары решает `resolvePosition` в tx.
 */
export function keyBetween(a: OrderKey | null, b: OrderKey | null, actor: ActorId): OrderKey {
  const da = orderDigits(a) ?? ''
  const dbRaw = orderDigits(b)
  const db = dbRaw !== null && dbRaw !== '' && dbRaw > da ? dbRaw : null
  return midpoint(da, db) + ORDER_SEP + actor
}

/** n ключей по возрастанию, все строго между a и b. */
export function keysBetween(
  a: OrderKey | null,
  b: OrderKey | null,
  n: number,
  actor: ActorId,
): OrderKey[] {
  const count = Math.max(0, Math.floor(n))
  if (count === 0) return []
  const da = orderDigits(a) ?? ''
  const dbRaw = orderDigits(b)
  const db = dbRaw !== null && dbRaw !== '' && dbRaw > da ? dbRaw : null
  return digitsBetween(da, db, count).map((d) => d + ORDER_SEP + actor)
}

function digitsBetween(a: string, b: string | null, n: number): string[] {
  if (n <= 0) return []
  if (b === null) {
    const out: string[] = []
    let cur = a
    for (let i = 0; i < n; i++) {
      cur = midpoint(cur, null)
      out.push(cur)
    }
    return out
  }
  const mid = midpoint(a, b)
  const leftCount = Math.floor((n - 1) / 2)
  const left = digitsBetween(a, mid, leftCount)
  const right = digitsBetween(mid, b, n - 1 - leftCount)
  return [...left, mid, ...right]
}

/** true, если группу пора переписать одним пакетом o-операций (§6.4). */
export function needsRebalance(keys: readonly OrderKey[]): boolean {
  for (const k of keys) if (k.length > REBALANCE_LEN) return true
  return false
}

/** Ровные ключи для всей группы после ребаланса. */
export function rebalanceKeys(count: number, actor: ActorId): OrderKey[] {
  return keysBetween(null, null, count, actor)
}

export function compareOrderKeys(a: OrderKey | undefined, b: OrderKey | undefined): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1 // записи без ключа — в конец
  if (b === undefined) return -1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Сортировка (orderKey, recordId): второй компонент для записей без ключа. */
export function compareOrder(
  a: { id: RecordId; key: OrderKey | undefined },
  b: { id: RecordId; key: OrderKey | undefined },
): number {
  const c = compareOrderKeys(a.key, b.key)
  if (c !== 0) return c
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
