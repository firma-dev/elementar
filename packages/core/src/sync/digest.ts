/**
 * Сводка «пока вас не было» (§6.12). Тост живёт секунды и не переживает офлайн-слияние,
 * поэтому при выходе из CATCHUP с более чем DIGEST_THRESHOLD чужими операциями
 * показывается шит со списком и «Вернуть» у каждой строки.
 */
import { C } from '@elementar/proto'
import { hlcActor } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import type { ChangeSet } from '../doc/apply.js'
import { isOrSet } from '../doc/state.js'
import type { DocState, Lww, RecordState } from '../doc/state.js'

export const DIGEST_THRESHOLD = C.DIGEST_THRESHOLD

/** Служебная коллекция имён участников (§6.14). */
const ACTORS_COLLECTION = '_actors'

export type DigestKind = 'created' | 'updated' | 'deleted' | 'moved'

export interface DigestItem {
  kind: DigestKind
  collection: string
  recordId: RecordId
  label: string
  fields?: string[]
  by: ActorId
  /** Правка по записи, которую этот человек редактировал офлайн. */
  conflictedWithMine: boolean
}

export interface CatchupDigest {
  /** epoch ms последнего онлайна. */
  since: number
  byActor: Array<{ actor: ActorId; name: string; created: number; updated: number; deleted: number }>
  items: DigestItem[]
}

export interface DigestOptions {
  since?: number
  /** Заголовок записи по схеме коллекции; по умолчанию — первое строковое поле. */
  labelOf?(collection: string, id: RecordId, rec: RecordState | undefined): string
  /** Записи, которые этот человек правил офлайн (из своего outbox/лога). */
  mine?: Iterable<RecordId>
}

function cellHlc(rec: RecordState, field: string): string | undefined {
  const cell = rec.f[field]
  if (cell === undefined) return undefined
  return isOrSet(cell) ? undefined : (cell as Lww).t
}

/** Кто последним трогал запись: актор берётся из хвоста HLC, а не из протокола. */
function actorOf(rec: RecordState | undefined, fields?: readonly string[]): ActorId {
  if (rec === undefined) return ''
  if (fields !== undefined) {
    let best = ''
    let bestT = ''
    for (const f of fields) {
      const t = cellHlc(rec, f)
      if (t !== undefined && t > bestT) {
        bestT = t
        best = hlcActor(t)
      }
    }
    if (best !== '') return best
  }
  return hlcActor(rec.upd)
}

function defaultLabel(state: DocState, collection: string, id: RecordId): string {
  const rec = state.col[collection]?.[id]
  if (rec === undefined) return id
  for (const key of ['title', 'name', 'text', 'label']) {
    const cell = rec.f[key]
    if (cell !== undefined && !isOrSet(cell)) {
      const v = (cell as Lww).v
      if (typeof v === 'string' && v !== '') return v
    }
  }
  for (const cell of Object.values(rec.f)) {
    if (isOrSet(cell)) continue
    const v = (cell as Lww).v
    if (typeof v === 'string' && v !== '') return v
  }
  return id
}

function actorNames(state: DocState): Map<ActorId, string> {
  const out = new Map<ActorId, string>()
  const bucket = state.col[ACTORS_COLLECTION]
  if (bucket === undefined) return out
  for (const [id, rec] of Object.entries(bucket)) {
    const cell = rec.f['name']
    const name = cell !== undefined && !isOrSet(cell) ? (cell as Lww).v : ''
    out.set(id, typeof name === 'string' && name !== '' ? name : 'Кто-то')
  }
  return out
}

/**
 * Сборка сводки. Свои правки в список не попадают: человек их и так помнит.
 * Служебные коллекции (`_actors`) тоже — это не событие для человека.
 */
export function buildDigest(
  changes: readonly ChangeSet[],
  state: DocState,
  mine: ActorId,
  opts: DigestOptions = {},
): CatchupDigest {
  const label =
    opts.labelOf ?? ((c: string, id: RecordId): string => defaultLabel(state, c, id))
  const mineTouched = new Set<RecordId>(opts.mine ?? [])
  const items: DigestItem[] = []
  const seen = new Set<string>()

  const push = (kind: DigestKind, collection: string, id: RecordId, fields?: string[]): void => {
    if (collection.startsWith('_')) return
    const key = `${kind}:${collection}:${id}`
    if (seen.has(key)) return
    const rec = state.col[collection]?.[id]
    const by = actorOf(rec, fields)
    if (by === mine || by === '') return
    seen.add(key)
    const item: DigestItem = {
      kind,
      collection,
      recordId: id,
      label: label(collection, id, rec),
      by,
      conflictedWithMine: mineTouched.has(id),
    }
    if (fields !== undefined && fields.length > 0) item.fields = fields.filter((f) => !f.startsWith('#'))
    items.push(item)
  }

  for (const cs of changes) {
    for (const a of cs.created) push('created', a.c, a.r)
    for (const a of cs.deleted) push('deleted', a.c, a.r)
    for (const a of cs.moved) push('moved', a.c, a.r)
    for (const [id, fields] of cs.updated) {
      const collection = cs.collectionOf.get(id)
      if (collection === undefined) continue
      const real = fields.filter((f) => !f.startsWith('#'))
      if (real.length === 0) continue
      push('updated', collection, id, real)
    }
  }

  const names = actorNames(state)
  const byActor = new Map<ActorId, { actor: ActorId; name: string; created: number; updated: number; deleted: number }>()
  for (const it of items) {
    let row = byActor.get(it.by)
    if (row === undefined) {
      row = { actor: it.by, name: names.get(it.by) ?? 'Кто-то', created: 0, updated: 0, deleted: 0 }
      byActor.set(it.by, row)
    }
    if (it.kind === 'created') row.created++
    else if (it.kind === 'deleted') row.deleted++
    else row.updated++
  }

  return {
    since: opts.since ?? 0,
    byActor: [...byActor.values()].sort((a, b) => (a.actor < b.actor ? -1 : 1)),
    items,
  }
}

/** Порог показа шита: больше DIGEST_THRESHOLD чужих операций (§6.12). */
export function shouldShowDigest(d: CatchupDigest): boolean {
  return d.items.length > DIGEST_THRESHOLD
}
