import type { HlcString } from '../hlc.js'
import type { RecordId } from '../id.js'
import type { DocState } from '../doc/state.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

/** Календарная дата без зоны, 'YYYY-MM-DD' (ADR 0005: зоны в планере нет). */
export type LocalDate = string
/** 'HH:MM'. */
export type LocalTime = string

export interface BlobRef {
  readonly id: string
  readonly size: number
  readonly mime: string
  readonly name?: string
}

export type FieldKind =
  | 'text'
  | 'number'
  | 'bool'
  | 'date'
  | 'time'
  | 'datetime'
  | 'enum'
  | 'ref'
  | 'tagged'
  | 'json' // всё выше — LWW-регистры
  | 'set' // OR-Set (add-wins)
  | 'blob' // ссылка на вложение

export interface FieldSchema<V = unknown> {
  readonly kind: FieldKind
  readonly default?: V
  readonly nullable?: boolean
  /** Предел длины/значения, проверяется в tx. */
  readonly max?: number
  /** Многострочный текст → хранить проигравшие версии. */
  readonly long?: boolean
  /** По умолчанию = long. */
  readonly keepConflicts?: boolean
  /** ref: имя коллекции. */
  readonly of?: string
  /** tagged (§3.4). */
  readonly variants?: Readonly<Record<string, { ref?: string }>>
  /** enum. */
  readonly values?: readonly string[]
  /** ref/tagged: политика висячей ссылки (§3.5). */
  readonly onDangling?: 'orphan' | 'keep'
  /** Не отдавать агенту без явного разрешения. */
  readonly redact?: boolean
}

export type FieldsDef = Record<string, FieldSchema<unknown>>

export type ValueOf<F> = F extends FieldSchema<infer V> ? V : never

export type RecordOfFields<T extends FieldsDef> = {
  readonly id: RecordId
  readonly createdAt: HlcString
  readonly updatedAt: HlcString
} & { -readonly [K in keyof T]: ValueOf<T[K]> }

export interface CollectionSchema<T extends FieldsDef = FieldsDef> {
  readonly fields: T
  /** Есть дробный индекс порядка. */
  readonly ordered?: boolean
  /** Поле-контейнер, внутри него ведётся свой порядок. Существование проверяет defineCorpus. */
  readonly groupBy?: string
  /** Человекочитаемое имя для корзины и предложений. Метод — чтобы вывод типов работал. */
  label(rec: RecordOfFields<T>): string
  readonly softDeleteDays?: number
  /** Политика архивации (§3.8): истина — запись живёт в снапшоте, но не материализуется. */
  cold?(rec: RecordOfFields<T>, now: number): boolean
}

export type RecordOf<C> = C extends CollectionSchema<infer T> ? RecordOfFields<T> : never

export type CollectionsDef = Record<string, CollectionSchema>

/** Шаг миграции документа: применяется к состоянию целиком, поднимает schema до `to`. */
export interface DocMigration {
  readonly to: number
  readonly describe?: string
  up(state: DocState): DocState
}

export interface CorpusDef<S extends CollectionsDef = CollectionsDef> {
  readonly id: string
  readonly schemaVersion: number
  readonly collections: S
  readonly migrations?: readonly DocMigration[]
  readonly meta?: Record<string, FieldSchema<unknown>>
}

export type CorpusData<D extends CorpusDef> = {
  [K in keyof D['collections']]: RecordOf<D['collections'][K]>
}

/** Карточка документа в списке (стор `docs`, §7.1). */
export interface DocCard {
  docId: string
  corpus: string
  title: string
  schemaVersion: number
  seq: number
  lastOpenedAt: number
  pinned: boolean
}

// ——— tagged (§3.4): контейнер в одной ячейке ———

export type Tagged = { variant: string; value: string }

/** Псевдогруппа для висячих ссылок (§3.5). */
export const ORPHAN = 'list:orphan' as const

/** 'proj:aB3k' → { variant: 'proj', value: 'aB3k' }. Разделитель — первое двоеточие. */
export function parseTagged(v: string): Tagged {
  const i = v.indexOf(':')
  if (i < 0) return { variant: v, value: '' }
  return { variant: v.slice(0, i), value: v.slice(i + 1) }
}

export function formatTagged(t: Tagged): string {
  return `${t.variant}:${t.value}`
}
