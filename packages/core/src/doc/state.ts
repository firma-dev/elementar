import { sha256 } from '@noble/hashes/sha2.js'
import { HLC_ZERO } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { RecordId } from '../id.js'
import type { OrderKey } from '../frac.js'
import type { JsonValue } from '../schema/types.js'
import { base32Encode, utf8 } from '../util/bytes.js'

/**
 * LWW-регистр. `c` — кольцо проигравших версий (для keepConflicts),
 * `z` — водяной знак «человек это поле видел»: проигравшие с t <= z не показываются.
 */
export interface Lww<V = JsonValue> {
  v: V
  t: HlcString
  c?: Array<{ v: V; t: HlcString }>
  z?: HlcString
}

/** OR-Set: элемент жив, пока add.t >= rem.t. */
export interface OrSet {
  e: Record<string, HlcString>
  x: Record<string, HlcString>
}

export type Cell = Lww | OrSet

export interface RecordState {
  f: Record<string, Cell>
  /** Дробный ключ порядка. */
  o?: Lww<OrderKey>
  /** Контейнер: зеркало значения groupBy-поля. */
  g?: Lww<string>
  /** Надгробие. */
  del?: HlcString
  /** Восстановление. */
  und?: HlcString
  cre: HlcString
  upd: HlcString
}

export interface DocState {
  v: 1
  corpus: string
  schema: number
  meta: Record<string, Lww>
  col: Record<string, Record<RecordId, RecordState>>
  /** Водяной знак чистки надгробий (§6.7). */
  purgedBefore: HlcString
  /** Голова хеш-цепочки лога (§6.11). base32, 32 байта. */
  chainHead: string
  /** Последний серверный seq, включённый в состояние. В слиянии не участвует. */
  seq: number
  /** Счётчик применённых операций с момента снапшота. */
  applied: number
  /**
   * Операции с неизвестным `k` — forward-compat (§3.7): хранятся как есть,
   * попадают в снапшот и уходят обратно в синк. Ключ — id операции.
   */
  xops?: Record<HlcString, JsonValue>
}

export const EMPTY_CHAIN_HEAD = ''

export function emptyState(corpus: string, schema: number): DocState {
  return {
    v: 1,
    corpus,
    schema,
    meta: {},
    col: {},
    purgedBefore: HLC_ZERO,
    chainHead: EMPTY_CHAIN_HEAD,
    seq: 0,
    applied: 0,
  }
}

export function emptyRecord(cre: HlcString): RecordState {
  return { f: {}, cre, upd: cre }
}

export function isOrSet(cell: Cell): cell is OrSet {
  return typeof (cell as OrSet).e === 'object' && (cell as OrSet).e !== null
}

export function isLww(cell: Cell): cell is Lww {
  return !isOrSet(cell)
}

/** Живость записи: удаление побеждает правку, восстановление — удаление (§6.5, §6.6b). */
export function isAlive(rec: RecordState): boolean {
  return rec.del === undefined || (rec.und !== undefined && rec.und > rec.del)
}

/** Живые элементы OR-Set, отсортированные (add-wins: e >= x). */
export function orSetValues(set: OrSet): string[] {
  const out: string[] = []
  for (const [el, added] of Object.entries(set.e)) {
    const removed = set.x[el]
    if (removed === undefined || added >= removed) out.push(el)
  }
  out.sort()
  return out
}

export function getRecord(state: DocState, collection: string, id: RecordId): RecordState | undefined {
  return state.col[collection]?.[id]
}

export function listRecords(state: DocState, collection: string): Array<[RecordId, RecordState]> {
  const bucket = state.col[collection]
  if (!bucket) return []
  return Object.entries(bucket)
}

// ——— каноническая сериализация (§3.10) ———

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null'
  if (t === 'boolean' || t === 'string') return JSON.stringify(value) as string
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`)
  }
  return `{${parts.join(',')}}`
}

export function canonicalJson(value: unknown): string {
  return stableStringify(value)
}

/**
 * Каноническая сериализация сходящейся части состояния: сортировка ключей, без пробелов.
 * `seq`, `applied` и `chainHead` — метаданные доставки, они законно различаются у двух
 * устройств и в побайтовое сравнение состояний не входят (§6.3, §6.8).
 */
export function canonicalize(state: DocState): Uint8Array {
  const core: Record<string, unknown> = {
    v: state.v,
    corpus: state.corpus,
    schema: state.schema,
    meta: state.meta,
    col: state.col,
    purgedBefore: state.purgedBefore,
  }
  if (state.xops && Object.keys(state.xops).length > 0) core['xops'] = state.xops
  return utf8(stableStringify(core))
}

/** Полная сериализация, включая метаданные доставки — для экспорта и отладки. */
export function canonicalizeFull(state: DocState): Uint8Array {
  return utf8(stableStringify(state))
}

/** base32 SHA-256 от canonicalize: то, что можно сравнить с партнёром голосом (§6.11). */
export function stateHash(state: DocState): string {
  return base32Encode(sha256(canonicalize(state)))
}
