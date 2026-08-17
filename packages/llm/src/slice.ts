/**
 * Что видит агент (§10.4): не весь документ, а срез — текущий контейнер целиком
 * плюс заголовки соседних контейнеров. Поля с `redact: true` вырезаются.
 * Служебные коллекции (имена с подчёркивания: _actors, _proposals) не отдаются вовсе.
 */
import {
  isAlive,
  listRecords,
  materializeRecord,
  runQuery,
} from '@elementar/core'
import type {
  CollectionSchema,
  CollectionsDef,
  CorpusDef,
  DocState,
  RecordId,
  RecordOf,
  RecordOfFields,
  FieldsDef,
  RecordState,
  Where,
} from '@elementar/core'

/** Значения полей могут быть вырезаны редактированием — поэтому запись частичная. */
export type Redacted<T> = { readonly [K in keyof T]?: T[K] } & { readonly id: RecordId }

export interface TitleRef {
  id: RecordId
  label: string
}

export interface ReadonlyCollection<T extends { id: RecordId }> {
  readonly name: string
  all(): readonly Redacted<T>[]
  byId(id: RecordId): Redacted<T> | undefined
  where(spec: Where<T>): readonly Redacted<T>[]
  count(): number
  /** Соседние контейнеры: только заголовки, без заметок. */
  titles(): readonly TitleRef[]
}

export type DocReadonly<S extends CollectionsDef> = {
  readonly [K in keyof S]: ReadonlyCollection<RecordOf<S[K]>>
} & {
  readonly corpus: string
  readonly meta: Readonly<Record<string, unknown>>
}

export interface SliceOptions {
  /** Текущий контейнер: коллекция, поле группировки и его значение. */
  container?: { collection: string; field: string; value: unknown }
  /** Явная галочка «показать агенту весь планер» — не по умолчанию (§10.4). */
  whole?: boolean
  /** Сколько записей отдавать целиком. */
  limit?: number
  /** Сколько заголовков соседей отдавать. */
  titleLimit?: number
}

export const SLICE_LIMIT_DEFAULT = 200
export const SLICE_TITLE_LIMIT_DEFAULT = 100

function isServiceCollection(name: string): boolean {
  return name.startsWith('_')
}

/** Материализация + вырезание redact-полей. */
function visibleRecord(
  col: CollectionSchema,
  id: RecordId,
  rec: RecordState,
): Record<string, unknown> {
  const full = materializeRecord(col, id, rec)
  for (const [field, fs] of Object.entries(col.fields)) {
    if (fs.redact === true) delete full[field]
  }
  return full
}

/** label() объявлен на типизированной записи; материализованная — её структурный носитель. */
function labelOf(col: CollectionSchema, value: Record<string, unknown>): string {
  try {
    return col.label(value as unknown as RecordOfFields<FieldsDef>)
  } catch {
    return String(value['id'] ?? '')
  }
}

interface Bucket {
  inside: Record<string, unknown>[]
  outside: TitleRef[]
}

function bucketOf(
  name: string,
  col: CollectionSchema,
  state: DocState,
  opts: SliceOptions,
): Bucket {
  const limit = opts.limit ?? SLICE_LIMIT_DEFAULT
  const titleLimit = opts.titleLimit ?? SLICE_TITLE_LIMIT_DEFAULT
  const inside: Record<string, unknown>[] = []
  const outside: TitleRef[] = []
  const container = opts.container
  const scoped = opts.whole !== true && container !== undefined && container.collection === name
  for (const [id, rec] of listRecords(state, name)) {
    if (!isAlive(rec)) continue
    const value = visibleRecord(col, id, rec)
    const belongs = !scoped || value[container.field] === container.value
    if (belongs) {
      if (inside.length < limit) inside.push(value)
    } else if (outside.length < titleLimit) {
      outside.push({ id, label: labelOf(col, value) })
    }
  }
  return { inside, outside }
}

function collectionView<T extends { id: RecordId }>(name: string, bucket: Bucket): ReadonlyCollection<T> {
  const rows = bucket.inside as unknown as Redacted<T>[]
  return {
    name,
    all: () => rows,
    byId: (id) => rows.find((r) => r.id === id),
    where: (spec) => runQuery(rows as unknown as T[], spec) as unknown as Redacted<T>[],
    count: () => rows.length,
    titles: () => bucket.outside,
  }
}

/**
 * Срез документа для инструментов агента. Мутирующего API у него нет
 * по построению: интерфейс отдаёт только чтение.
 */
export function createDocReadonly<S extends CollectionsDef>(
  def: CorpusDef<S>,
  state: DocState,
  opts: SliceOptions = {},
): DocReadonly<S> {
  const out: Record<string, unknown> = {
    corpus: def.id,
    meta: metaOf(state),
  }
  for (const [name, col] of Object.entries(def.collections)) {
    if (isServiceCollection(name)) continue
    out[name] = collectionView(name, bucketOf(name, col, state, opts))
  }
  return out as DocReadonly<S>
}

function metaOf(state: DocState): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  for (const [key, cell] of Object.entries(state.meta)) meta[key] = cell.v
  return meta
}

/** Сколько записей ушло бы в модель: показывается человеку перед запуском. */
export function sliceSize<S extends CollectionsDef>(doc: DocReadonly<S>, def: CorpusDef<S>): number {
  let total = 0
  for (const name of Object.keys(def.collections)) {
    if (isServiceCollection(name)) continue
    const col = (doc as unknown as Record<string, ReadonlyCollection<{ id: RecordId }>>)[name]
    if (col !== undefined) total += col.count()
  }
  return total
}
