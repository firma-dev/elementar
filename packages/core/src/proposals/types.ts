/**
 * Предложения агента (§10.4): агент предлагает — человек подтверждает.
 * Предложения — наложение, а не записи: поля `draft` в схемах не существует,
 * механизм один — коллекция `_proposals` внутри документа (значит, видна партнёру).
 */
import type { HlcString } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import type { JsonValue } from '../schema/types.js'
import type { AnyOp, Op } from '../ops/types.js'
import { parseOp } from '../ops/codec.js'
import { isKnownOp } from '../ops/types.js'
import { isHlc } from '../hlc.js'
import { isOrSet } from '../doc/state.js'
import type { DocState, Lww, RecordState } from '../doc/state.js'

/** Коллекция предложений: служебная, обычными запросами не видна. */
export const PROPOSALS_COLLECTION = '_proposals'

/** Истечение черновиков — фильтр представления, а не операция (§10.4). */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000

export type ProposalChangeKind = 'create' | 'update' | 'delete' | 'move'
export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface ProposalChange {
  kind: ProposalChangeKind
  collection: string
  /** Предвычислен, чтобы accept был детерминирован. */
  recordId: RecordId
  label: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** Операции ИМЕННО этого изменения. Верхнеуровневого ops[] нет. */
  ops: Op[]
}

export interface ProposalOrigin {
  provider: string
  model: string
  runId: string
  toolName: string
  by: ActorId
}

export interface Proposal {
  id: RecordId
  title: string
  rationale?: string
  origin: ProposalOrigin
  changes: ProposalChange[]
  /** Отпечаток: 'recordId#field' → HLC на момент создания. Для isStale. */
  base: Record<string, HlcString>
  status: ProposalStatus
  createdAt: HlcString
}

/**
 * Контракт: ProposeTool.plan возвращает черновик без id, origin, base и статуса —
 * их проставляет store при put(). В документе тип явно не задан (§10.4), объявлен здесь.
 */
export interface ProposalDraft {
  title: string
  rationale?: string
  changes: ProposalChange[]
}

export function baseKey(recordId: RecordId, field: string): string {
  return `${recordId}#${field}`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseOps(raw: unknown): Op[] | null {
  if (!Array.isArray(raw)) return null
  const out: Op[] = []
  for (const item of raw) {
    const op: AnyOp | null = parseOp(item)
    // предложение может нести только известные операции: неизвестные нечем применить
    if (op === null || !isKnownOp(op)) return null
    out.push(op)
  }
  return out
}

export function parseProposalChange(raw: unknown): ProposalChange | null {
  if (!isPlainObject(raw)) return null
  const kind = raw['kind']
  if (kind !== 'create' && kind !== 'update' && kind !== 'delete' && kind !== 'move') return null
  const collection = raw['collection']
  const recordId = raw['recordId']
  const label = raw['label']
  if (typeof collection !== 'string' || typeof recordId !== 'string') return null
  const ops = parseOps(raw['ops'])
  if (ops === null) return null
  const change: ProposalChange = {
    kind,
    collection,
    recordId,
    label: typeof label === 'string' ? label : '',
    ops,
  }
  if (isPlainObject(raw['before'])) change.before = raw['before']
  if (isPlainObject(raw['after'])) change.after = raw['after']
  return change
}

function parseOrigin(raw: unknown): ProposalOrigin | null {
  if (!isPlainObject(raw)) return null
  const s = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '')
  return { provider: s('provider'), model: s('model'), runId: s('runId'), toolName: s('toolName'), by: s('by') }
}

function parseBase(raw: unknown): Record<string, HlcString> {
  if (!isPlainObject(raw)) return {}
  const out: Record<string, HlcString> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && isHlc(v)) out[k] = v
  return out
}

function lwwValue(rec: RecordState, field: string): unknown {
  const cell = rec.f[field]
  if (cell === undefined || isOrSet(cell)) return undefined
  return (cell as Lww).v
}

/** Разбор записи `_proposals` из состояния документа: пришедшее от партнёра тоже проверяется. */
export function proposalFromRecord(id: RecordId, rec: RecordState): Proposal | null {
  const title = lwwValue(rec, 'title')
  const changesRaw = lwwValue(rec, 'changes')
  const status = lwwValue(rec, 'status')
  const origin = parseOrigin(lwwValue(rec, 'origin'))
  if (typeof title !== 'string' || origin === null) return null
  if (status !== 'pending' && status !== 'accepted' && status !== 'rejected') return null
  if (!Array.isArray(changesRaw)) return null
  const changes: ProposalChange[] = []
  for (const c of changesRaw) {
    const parsed = parseProposalChange(c)
    if (parsed === null) return null
    changes.push(parsed)
  }
  const createdAt = lwwValue(rec, 'createdAt')
  const rationale = lwwValue(rec, 'rationale')
  const p: Proposal = {
    id,
    title,
    origin,
    changes,
    base: parseBase(lwwValue(rec, 'base')),
    status,
    createdAt: typeof createdAt === 'string' && isHlc(createdAt) ? createdAt : rec.cre,
  }
  if (typeof rationale === 'string' && rationale !== '') p.rationale = rationale
  return p
}

/** Поля записи `_proposals`: всё, что уходит в SetOp. */
export function proposalToFields(p: Proposal): Record<string, JsonValue> {
  return {
    title: p.title,
    rationale: p.rationale ?? '',
    origin: { ...p.origin } as unknown as JsonValue,
    changes: p.changes as unknown as JsonValue,
    base: { ...p.base },
    status: p.status,
    createdAt: p.createdAt,
  }
}

export function listProposals(state: DocState): Proposal[] {
  const bucket = state.col[PROPOSALS_COLLECTION]
  if (bucket === undefined) return []
  const out: Proposal[] = []
  for (const [id, rec] of Object.entries(bucket)) {
    if (rec.del !== undefined && (rec.und === undefined || rec.und <= rec.del)) continue
    const p = proposalFromRecord(id, rec)
    if (p !== null) out.push(p)
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return out
}
