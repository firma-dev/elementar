import type { Clock, HlcString } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import { recordId as newRecordId } from '../id.js'
import { keyBetween, orderDigits } from '../frac.js'
import type { OrderKey } from '../frac.js'
import { defaultValue, keepsConflicts, validateFieldValue } from '../schema/define.js'
import { parseTagged } from '../schema/types.js'
import type {
  CollectionSchema,
  CollectionsDef,
  CorpusDef,
  FieldSchema,
  JsonValue,
  RecordOf,
} from '../schema/types.js'
import type { Op } from '../ops/types.js'
import { apply, mergeChangeSets, emptyChangeSet } from './apply.js'
import type { ApplyContext, ChangeSet } from './apply.js'
import { isAlive, isLww, isOrSet, orSetValues } from './state.js'
import type { DocState, Lww, RecordState } from './state.js'

export class TxError extends Error {
  override readonly name = 'TxError'
  readonly collection?: string
  readonly field?: string
  constructor(message: string, where?: { collection?: string; field?: string }) {
    super(message)
    if (where?.collection !== undefined) this.collection = where.collection
    if (where?.field !== undefined) this.field = where.field
  }
}

export type Position =
  | { at: 'start' | 'end' }
  | { before: RecordId }
  | { after: RecordId }
  | { group: string; at?: 'start' | 'end' }

export interface TxCollection<T extends { id: RecordId }> {
  /** id — необязателен; нужен для импорта, для предложений агента и для серий (§6.9). */
  create(value: Partial<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>, pos?: Position, id?: RecordId): RecordId
  update(id: RecordId, patch: Partial<T>): void
  remove(id: RecordId): void
  restore(id: RecordId): void
  move(id: RecordId, pos: Position): void
  addTo(id: RecordId, field: keyof T & string, ...items: string[]): void
  removeFrom(id: RecordId, field: keyof T & string, ...items: string[]): void
  resolveConflict(id: RecordId, field: keyof T & string, value: unknown): void
}

export interface Tx<S extends CollectionsDef> {
  readonly col: { [K in keyof S]: TxCollection<RecordOf<S[K]>> }
  meta(patch: Record<string, JsonValue>): void
}

export interface TxResult {
  ops: number
  ids: RecordId[]
  undoToken: string | null
}

export interface TxEnv {
  state: DocState
  def: CorpusDef
  clock: Clock
  actor: ActorId
  ctx: ApplyContext
}

export interface TxRun {
  ops: Op[]
  ids: RecordId[]
  state: DocState
  changes: ChangeSet
}

interface Ordered {
  id: RecordId
  key: OrderKey | undefined
}

function liveRecords(state: DocState, collection: string): Array<[RecordId, RecordState]> {
  const bucket = state.col[collection]
  if (!bucket) return []
  return Object.entries(bucket).filter(([, rec]) => isAlive(rec))
}

function groupValueOf(rec: RecordState, groupBy: string | undefined): string | undefined {
  if (groupBy === undefined) return undefined
  const cell = rec.f[groupBy]
  if (cell !== undefined && isLww(cell) && typeof cell.v === 'string') return cell.v
  const g = rec.g
  return g !== undefined ? g.v : undefined
}

/** Живые записи группы в порядке (orderKey, recordId). */
function orderedGroup(
  state: DocState,
  collection: string,
  groupBy: string | undefined,
  group: string | undefined,
  exclude?: RecordId,
): Ordered[] {
  const out: Ordered[] = []
  for (const [id, rec] of liveRecords(state, collection)) {
    if (id === exclude) continue
    if (group !== undefined && groupValueOf(rec, groupBy) !== group) continue
    out.push({ id, key: rec.o?.v })
  }
  out.sort((a, b) => {
    if (a.key !== b.key) {
      if (a.key === undefined) return 1
      if (b.key === undefined) return -1
      return a.key < b.key ? -1 : 1
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return out
}

/**
 * Ключ между соседями. Если у соседей совпадает цифровая часть (двое офлайн вставили
 * в одно место), встать внутрь такой пары нельзя — тогда ключ ставится перед всей парой.
 */
function keyAt(list: Ordered[], leftIndex: number, rightIndex: number, actor: ActorId): OrderKey {
  const rightKey = rightIndex < list.length ? (list[rightIndex] as Ordered).key ?? null : null
  let left = leftIndex
  while (left >= 0) {
    const lk = (list[left] as Ordered).key ?? null
    if (rightKey === null || orderDigits(lk) !== orderDigits(rightKey)) break
    left--
  }
  const leftKey = left >= 0 ? (list[left] as Ordered).key ?? null : null
  return keyBetween(leftKey, rightKey, actor)
}

export function createTx(env: TxEnv): { tx: Tx<CollectionsDef>; run: TxRun } {
  const { def, clock, actor, ctx } = env
  const run: TxRun = { ops: [], ids: [], state: env.state, changes: emptyChangeSet() }

  const push = (op: Op): void => {
    const res = apply(run.state, op, ctx)
    run.state = res.state
    mergeChangeSets(run.changes, res.changes)
    run.ops.push(op)
  }

  const schemaOf = (collection: string): CollectionSchema => {
    const c = def.collections[collection]
    if (c === undefined) throw new TxError(`неизвестная коллекция «${collection}»`, { collection })
    return c
  }

  const fieldOf = (collection: string, field: string): FieldSchema<unknown> => {
    const fs = schemaOf(collection).fields[field]
    if (fs === undefined) throw new TxError(`неизвестное поле «${field}»`, { collection, field })
    return fs
  }

  const requireRecord = (collection: string, id: RecordId): RecordState => {
    const rec = run.state.col[collection]?.[id]
    if (rec === undefined) throw new TxError(`запись ${id} не найдена`, { collection })
    return rec
  }

  /** Ссылка обязана указывать на живую запись — но только здесь, слияние это правило обходит (§3.5). */
  const checkRef = (collection: string, field: string, target: string, of: string, selfId?: RecordId): void => {
    if (of === collection && target === selfId) return // запись серии ссылается сама на себя
    const rec = run.state.col[of]?.[target]
    if (rec === undefined || !isAlive(rec))
      throw new TxError(`поле «${field}»: запись ${target} в «${of}» не существует`, { collection, field })
  }

  const validate = (collection: string, field: string, value: unknown, selfId?: RecordId): void => {
    const fs = fieldOf(collection, field)
    const err = validateFieldValue(field, fs, value)
    if (err !== null) throw new TxError(err, { collection, field })
    if (fs.kind === 'ref' && typeof value === 'string' && value !== '' && fs.of !== undefined)
      checkRef(collection, field, value, fs.of, selfId)
    if (fs.kind === 'tagged' && typeof value === 'string') {
      const t = parseTagged(value)
      const variant = fs.variants?.[t.variant]
      if (variant?.ref !== undefined && t.value !== '')
        checkRef(collection, field, t.value, variant.ref, selfId)
    }
  }

  /** База правки для полей с keepConflicts: HLC ячейки, которую человек видел. */
  const baseFor = (collection: string, id: RecordId, fields: readonly string[]): Record<string, HlcString> | undefined => {
    const rec = run.state.col[collection]?.[id]
    if (rec === undefined) return undefined
    let out: Record<string, HlcString> | undefined
    for (const field of fields) {
      const fs = def.collections[collection]?.fields[field]
      if (fs === undefined || !keepsConflicts(fs)) continue
      const cell = rec.f[field]
      if (cell === undefined || !isLww(cell)) continue
      out ??= {}
      out[field] = cell.t
    }
    return out
  }

  const resolvePosition = (collection: string, id: RecordId, pos: Position | undefined): { o: OrderKey; g?: string } => {
    const col = schemaOf(collection)
    const groupBy = col.groupBy
    const rec = run.state.col[collection]?.[id]
    let group: string | undefined = rec !== undefined ? groupValueOf(rec, groupBy) : undefined
    let at: 'start' | 'end' = 'end'
    let anchor: RecordId | null = null
    let anchorSide: 'before' | 'after' = 'after'

    if (pos !== undefined) {
      if ('group' in pos) {
        group = pos.group
        at = pos.at ?? 'end'
      } else if ('before' in pos) {
        anchor = pos.before
        anchorSide = 'before'
      } else if ('after' in pos) {
        anchor = pos.after
        anchorSide = 'after'
      } else {
        at = pos.at
      }
    }

    if (anchor !== null) {
      const arec = run.state.col[collection]?.[anchor]
      if (arec === undefined) throw new TxError(`запись-якорь ${anchor} не найдена`, { collection })
      group = groupValueOf(arec, groupBy)
    }

    const list = orderedGroup(run.state, collection, groupBy, groupBy === undefined ? undefined : group, id)
    let key: OrderKey
    if (anchor !== null) {
      const at0 = list.findIndex((x) => x.id === anchor)
      if (at0 < 0) key = keyAt(list, list.length - 1, list.length, actor)
      else if (anchorSide === 'before') key = keyAt(list, at0 - 1, at0, actor)
      else key = keyAt(list, at0, at0 + 1, actor)
    } else if (at === 'start') {
      key = keyAt(list, -1, 0, actor)
    } else {
      key = keyAt(list, list.length - 1, list.length, actor)
    }
    return group === undefined ? { o: key } : { o: key, g: group }
  }

  const makeCollection = (collection: string): TxCollection<{ id: RecordId }> => ({
    create(value, pos, id): RecordId {
      const col = schemaOf(collection)
      const rid = id ?? newRecordId()
      const patch: Record<string, JsonValue> = {}
      for (const [field, fs] of Object.entries(col.fields)) {
        const given = (value as Record<string, unknown>)[field]
        if (given !== undefined) {
          validate(collection, field, given, rid)
          if (fs.kind === 'set') continue // множества наполняются addTo
          patch[field] = given as JsonValue
          continue
        }
        const def0 = defaultValue(fs)
        if (def0 !== undefined && fs.kind !== 'set') patch[field] = def0
      }
      for (const field of Object.keys(value as Record<string, unknown>))
        if (col.fields[field] === undefined)
          throw new TxError(`неизвестное поле «${field}»`, { collection, field })

      push({ i: clock.tick(), k: 's', c: collection, r: rid, v: patch })

      const sets = Object.entries(col.fields).filter(([, fs]) => fs.kind === 'set')
      for (const [field] of sets) {
        const given = (value as Record<string, unknown>)[field]
        if (Array.isArray(given) && given.length > 0)
          push({ i: clock.tick(), k: 'g+', c: collection, r: rid, p: field, e: given.map(String) })
      }

      if (col.ordered === true) {
        const p = resolvePosition(collection, rid, pos)
        push({ i: clock.tick(), k: 'o', c: collection, r: rid, ...(p.g === undefined ? { o: p.o } : { o: p.o, g: p.g }) })
      }
      run.ids.push(rid)
      return rid
    },

    update(id, patch): void {
      requireRecord(collection, id)
      const v: Record<string, JsonValue> = {}
      const fields: string[] = []
      for (const [field, value] of Object.entries(patch as Record<string, unknown>)) {
        if (value === undefined) continue
        const fs = fieldOf(collection, field)
        if (fs.kind === 'set')
          throw new TxError(`поле «${field}» — множество, правится через addTo/removeFrom`, {
            collection,
            field,
          })
        validate(collection, field, value)
        v[field] = value as JsonValue
        fields.push(field)
      }
      if (fields.length === 0) return
      const b = baseFor(collection, id, fields)
      push({ i: clock.tick(), k: 's', c: collection, r: id, v, ...(b === undefined ? {} : { b }) })
    },

    remove(id): void {
      requireRecord(collection, id)
      push({ i: clock.tick(), k: 'd', c: collection, r: id })
    },

    restore(id): void {
      requireRecord(collection, id)
      push({ i: clock.tick(), k: 'u', c: collection, r: id })
    },

    move(id, pos): void {
      const col = schemaOf(collection)
      requireRecord(collection, id)
      if (col.ordered !== true) throw new TxError(`коллекция «${collection}» без ручного порядка`, { collection })
      if ('group' in pos && col.groupBy !== undefined) {
        validate(collection, col.groupBy, pos.group)
        push({ i: clock.tick(), k: 's', c: collection, r: id, v: { [col.groupBy]: pos.group } })
      }
      const p = resolvePosition(collection, id, pos)
      push({ i: clock.tick(), k: 'o', c: collection, r: id, ...(p.g === undefined ? { o: p.o } : { o: p.o, g: p.g }) })
    },

    addTo(id, field, ...items): void {
      requireRecord(collection, id)
      const fs = fieldOf(collection, field)
      if (fs.kind !== 'set') throw new TxError(`поле «${field}» — не множество`, { collection, field })
      if (items.length === 0) return
      push({ i: clock.tick(), k: 'g+', c: collection, r: id, p: field, e: [...items] })
    },

    removeFrom(id, field, ...items): void {
      requireRecord(collection, id)
      const fs = fieldOf(collection, field)
      if (fs.kind !== 'set') throw new TxError(`поле «${field}» — не множество`, { collection, field })
      if (items.length === 0) return
      push({ i: clock.tick(), k: 'g-', c: collection, r: id, p: field, e: [...items] })
    },

    resolveConflict(id, field, value): void {
      const rec = requireRecord(collection, id)
      validate(collection, field, value)
      const cell = rec.f[field]
      const b: Record<string, HlcString> = {}
      if (cell !== undefined && isLww(cell)) b[field] = cell.t
      push({
        i: clock.tick(),
        k: 's',
        c: collection,
        r: id,
        v: { [field]: value as JsonValue },
        ...(cell !== undefined && isLww(cell) ? { b } : {}),
      })
    },
  })

  const cols: Record<string, TxCollection<{ id: RecordId }>> = {}
  for (const name of Object.keys(def.collections)) cols[name] = makeCollection(name)

  const tx: Tx<CollectionsDef> = {
    col: cols as unknown as Tx<CollectionsDef>['col'],
    meta(patch: Record<string, JsonValue>): void {
      const v: Record<string, JsonValue> = {}
      const fields: string[] = []
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        const fs = def.meta?.[key]
        if (fs !== undefined) {
          const err = validateFieldValue(key, fs, value)
          if (err !== null) throw new TxError(err, { field: key })
        }
        v[key] = value
        fields.push(key)
      }
      if (fields.length === 0) return
      const b: Record<string, HlcString> = {}
      for (const key of fields) {
        const fs = def.meta?.[key]
        const cell = run.state.meta[key]
        if (fs !== undefined && keepsConflicts(fs) && cell !== undefined) b[key] = cell.t
      }
      push({ i: clock.tick(), k: 'm', v, ...(Object.keys(b).length > 0 ? { b } : {}) })
    },
  }

  return { tx, run }
}

/** Значения ячеек записи в виде обычного объекта — для undo и для сводок. */
export function cellValues(rec: RecordState): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [field, cell] of Object.entries(rec.f)) {
    if (isOrSet(cell)) out[field] = orSetValues(cell)
    else out[field] = (cell as Lww).v
  }
  return out
}
