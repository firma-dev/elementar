import type { ApplyContext } from '../doc/apply.js'
import type { Tx } from '../doc/tx.js'
import type { DocCore } from '../doc/handle.js'
import type { RecordId } from '../id.js'
import type {
  BlobRef,
  CollectionSchema,
  CollectionsDef,
  CorpusDef,
  DocCard,
  DocMigration,
  FieldSchema,
  FieldsDef,
  JsonValue,
  LocalDate,
  LocalTime,
} from './types.js'

/** Конструкторы полей (§3.3). Ничего, кроме описания: значения проверяются в tx. */
export const f = {
  text(o?: { max?: number; long?: boolean; keepConflicts?: boolean }): FieldSchema<string> {
    const long = o?.long ?? false
    return {
      kind: 'text',
      default: '',
      max: o?.max,
      long,
      keepConflicts: o?.keepConflicts ?? long,
    }
  },
  number(o?: { max?: number }): FieldSchema<number> {
    return { kind: 'number', default: 0, max: o?.max }
  },
  bool(def = false): FieldSchema<boolean> {
    return { kind: 'bool', default: def }
  },
  /** Календарная дата без зоны. */
  date(): FieldSchema<LocalDate> {
    return { kind: 'date', default: '' }
  },
  time(): FieldSchema<LocalTime> {
    return { kind: 'time', default: '' }
  },
  /** ISO-8601 с зоной — для постера и почтера, в планере не используется. */
  datetime(): FieldSchema<string> {
    return { kind: 'datetime', default: '' }
  },
  enum<const V extends readonly string[]>(values: V, o?: { default?: V[number] }): FieldSchema<V[number]> {
    return { kind: 'enum', values, default: o?.default ?? (values[0] as V[number]) }
  },
  ref<C extends string>(collection: C, o?: { onDangling?: 'orphan' | 'keep' }): FieldSchema<RecordId | null> {
    return { kind: 'ref', of: collection, nullable: true, default: null, onDangling: o?.onDangling ?? 'orphan' }
  },
  /** Размеченное объединение в ОДНОЙ ячейке: 'list:home' | 'proj:<recordId>' (§3.4). */
  tagged<const V extends Record<string, { ref?: string }>>(
    variants: V,
    o?: { default?: string; onDangling?: 'orphan' | 'keep' },
  ): FieldSchema<string> {
    const first = Object.keys(variants)[0] ?? ''
    return {
      kind: 'tagged',
      variants,
      default: o?.default ?? `${first}:`,
      onDangling: o?.onDangling ?? 'orphan',
    }
  },
  set<V extends string = string>(): FieldSchema<readonly V[]> {
    return { kind: 'set', default: [] as readonly V[] }
  },
  json<V extends JsonValue>(): FieldSchema<V> {
    return { kind: 'json' }
  },
  blob(): FieldSchema<BlobRef | null> {
    return { kind: 'blob', nullable: true, default: null }
  },
  nullable<V>(s: FieldSchema<V>): FieldSchema<V | null> {
    return { ...s, nullable: true, default: null }
  },
} as const

/** Хранить ли проигравшие версии поля: keepConflicts, по умолчанию = long. */
export function keepsConflicts(schema: FieldSchema<unknown>): boolean {
  return schema.keepConflicts ?? schema.long ?? false
}

export function defaultValue(schema: FieldSchema<unknown>): JsonValue | undefined {
  if (schema.default !== undefined) return schema.default as JsonValue
  if (schema.nullable === true) return null
  switch (schema.kind) {
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
      return ''
    case 'number':
      return 0
    case 'bool':
      return false
    case 'set':
      return []
    default:
      return undefined
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isLocalDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map((x) => Number.parseInt(x, 10)) as [number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

export function isLocalTime(s: string): boolean {
  return TIME_RE.test(s)
}

/** Проверка значения поля по схеме. Возвращает текст ошибки или null. */
export function validateFieldValue(field: string, schema: FieldSchema<unknown>, value: unknown): string | null {
  if (value === null) return schema.nullable === true ? null : `поле «${field}» не может быть null`
  switch (schema.kind) {
    case 'text':
    case 'datetime': {
      if (typeof value !== 'string') return `поле «${field}» — строка`
      if (schema.max !== undefined && value.length > schema.max)
        return `поле «${field}» длиннее ${schema.max} символов`
      return null
    }
    case 'date':
      if (typeof value !== 'string' || (value !== '' && !isLocalDate(value)))
        return `поле «${field}» — дата 'YYYY-MM-DD'`
      return null
    case 'time':
      if (typeof value !== 'string' || (value !== '' && !isLocalTime(value)))
        return `поле «${field}» — время 'HH:MM'`
      return null
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `поле «${field}» — число`
      if (schema.max !== undefined && value > schema.max) return `поле «${field}» больше ${schema.max}`
      return null
    }
    case 'bool':
      return typeof value === 'boolean' ? null : `поле «${field}» — булево`
    case 'enum':
      return typeof value === 'string' && (schema.values ?? []).includes(value)
        ? null
        : `поле «${field}» — одно из: ${(schema.values ?? []).join(', ')}`
    case 'ref':
      return typeof value === 'string' ? null : `поле «${field}» — ссылка на запись`
    case 'tagged': {
      if (typeof value !== 'string') return `поле «${field}» — строка '<вариант>:<значение>'`
      const i = value.indexOf(':')
      if (i < 0) return `поле «${field}» — строка '<вариант>:<значение>'`
      const variant = value.slice(0, i)
      if (schema.variants === undefined || !Object.prototype.hasOwnProperty.call(schema.variants, variant))
        return `поле «${field}»: неизвестный вариант «${variant}»`
      return null
    }
    case 'set':
      return Array.isArray(value) && value.every((x) => typeof x === 'string')
        ? null
        : `поле «${field}» — множество строк`
    case 'blob': {
      if (typeof value !== 'object' || value === null) return `поле «${field}» — ссылка на вложение`
      const b = value as Partial<BlobRef>
      return typeof b.id === 'string' && typeof b.size === 'number' ? null : `поле «${field}» — ссылка на вложение`
    }
    case 'json':
      return null
    default:
      return null
  }
}

export interface OpenOptions {
  sync?: boolean
  endpoint?: string
  password?: string
  readOnly?: boolean
}

export interface DocRef {
  docId: string
}

export interface CorpusCreateInit<S extends CollectionsDef> {
  title?: string
  seed?: (t: Tx<S>) => void
}

/**
 * Рантайм корпуса — хранилище и синк. Живёт в другом слое ядра и подключается
 * фасадом (`index.ts`) через `setCorpusRuntime`: модель документа не знает ни про IndexedDB,
 * ни про сеть.
 */
export interface CorpusRuntime {
  create(def: CorpusDef, init?: CorpusCreateInit<CollectionsDef>): Promise<unknown>
  open(def: CorpusDef, ref: string | DocRef, opts?: OpenOptions): Promise<unknown>
  list(def: CorpusDef): Promise<DocCard[]>
  forget(def: CorpusDef, docId: string): Promise<void>
}

export class CorpusRuntimeError extends Error {
  override readonly name = 'CorpusRuntimeError'
  constructor(method: string) {
    super(`рантайм корпуса не подключён: ${method} недоступен (нужен фасад @elementar/core)`)
  }
}

let runtime: CorpusRuntime | null = null

export function setCorpusRuntime(rt: CorpusRuntime | null): void {
  runtime = rt
}

export function getCorpusRuntime(): CorpusRuntime | null {
  return runtime
}

export interface Corpus<S extends CollectionsDef, H = DocCore<S>> extends CorpusDef<S> {
  create(init?: CorpusCreateInit<S>): Promise<H>
  open(ref: string | DocRef, opts?: OpenOptions): Promise<H>
  list(): Promise<DocCard[]>
  forget(docId: string): Promise<void>
}

export class SchemaError extends Error {
  override readonly name = 'SchemaError'
}

function validateDef(def: CorpusDef): void {
  if (def.id.length === 0) throw new SchemaError('у корпуса должен быть id')
  for (const [name, col] of Object.entries(def.collections)) {
    const fields = col.fields
    if (col.groupBy !== undefined) {
      const g = fields[col.groupBy]
      if (g === undefined) throw new SchemaError(`${name}.groupBy указывает на несуществующее поле «${col.groupBy}»`)
      if (g.kind !== 'tagged' && g.kind !== 'enum' && g.kind !== 'ref')
        throw new SchemaError(`${name}.groupBy должен быть tagged, enum или ref, а не ${g.kind}`)
    }
    for (const [fname, fs] of Object.entries(fields)) {
      if (fs.kind === 'ref' && fs.of !== undefined && def.collections[fs.of] === undefined)
        throw new SchemaError(`${name}.${fname}: ссылка на неизвестную коллекцию «${fs.of}»`)
      if (fs.kind === 'tagged')
        for (const [vname, v] of Object.entries(fs.variants ?? {}))
          if (v.ref !== undefined && def.collections[v.ref] === undefined)
            throw new SchemaError(`${name}.${fname}: вариант «${vname}» ссылается на неизвестную коллекцию «${v.ref}»`)
    }
  }
}

/** Коллекции, выведенные из карты полей: нужно для вывода типов в `label` и `cold`. */
export type CollectionsOf<F extends Record<string, FieldsDef>> = { [K in keyof F]: CollectionSchema<F[K]> }

export interface CorpusInput<F extends Record<string, FieldsDef>> {
  readonly id: string
  readonly schemaVersion: number
  readonly collections: CollectionsOf<F>
  readonly migrations?: readonly DocMigration[]
  readonly meta?: Record<string, FieldSchema<unknown>>
}

/**
 * Единственный источник модели документа (§7.7).
 * Вывод идёт через карту полей `F`, иначе `label: (t) => t.title` получил бы `t: unknown`:
 * тип полей коллекции выводится из её же литерала.
 */
export function defineCorpus<F extends Record<string, FieldsDef>>(
  input: CorpusInput<F>,
): Corpus<CollectionsOf<F>> {
  type S = CollectionsOf<F>
  const def = input as unknown as CorpusDef<S>
  validateDef(def)
  const corpus: Corpus<S> = {
    ...def,
    async create(init?: CorpusCreateInit<S>): Promise<DocCore<S>> {
      const rt = runtime
      if (rt === null) throw new CorpusRuntimeError('create')
      return (await rt.create(def, init as CorpusCreateInit<CollectionsDef> | undefined)) as DocCore<S>
    },
    async open(ref: string | DocRef, opts?: OpenOptions): Promise<DocCore<S>> {
      const rt = runtime
      if (rt === null) throw new CorpusRuntimeError('open')
      return (await rt.open(def, ref, opts)) as DocCore<S>
    },
    async list(): Promise<DocCard[]> {
      const rt = runtime
      if (rt === null) throw new CorpusRuntimeError('list')
      return rt.list(def)
    },
    async forget(docId: string): Promise<void> {
      const rt = runtime
      if (rt === null) throw new CorpusRuntimeError('forget')
      return rt.forget(def, docId)
    },
  }
  return corpus
}

export function collectionOf(def: CorpusDef, name: string): CollectionSchema | undefined {
  return def.collections[name]
}

/** Контекст apply, выведенный из схемы: где хранить конфликты и что считать контейнером. */
export function applyContextOf(def: CorpusDef): ApplyContext {
  return {
    keepConflicts(collection: string, field: string): boolean {
      const fs =
        collection === '' ? def.meta?.[field] : def.collections[collection]?.fields[field]
      return fs === undefined ? false : keepsConflicts(fs)
    },
    groupBy(collection: string): string | undefined {
      return def.collections[collection]?.groupBy
    },
  }
}
