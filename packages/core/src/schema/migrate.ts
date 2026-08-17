import type { DocState } from '../doc/state.js'
import type { CorpusDef, DocMigration } from './types.js'

/** Разрыв больше двух версий — документ открывается только на чтение (§6.6g). */
export const SCHEMA_AHEAD_LIMIT = 2

export type MigrateStatus = 'ok' | 'migrated' | 'ahead' | 'blocked'

export interface MigrateResult {
  state: DocState
  status: MigrateStatus
  /** Документ старше приложения на 1–2 версии: работаем, но пишем осторожно. */
  readOnly: boolean
  applied: number[]
}

/**
 * Приведение состояния к версии схемы приложения.
 * Вперёд (документ новее приложения) не мигрируем никогда: неизвестное сохраняется как есть.
 */
export function migrateState(state: DocState, def: CorpusDef): MigrateResult {
  const target = def.schemaVersion
  if (state.schema > target + SCHEMA_AHEAD_LIMIT)
    return { state, status: 'blocked', readOnly: true, applied: [] }
  if (state.schema > target) return { state, status: 'ahead', readOnly: false, applied: [] }
  if (state.schema === target) return { state, status: 'ok', readOnly: false, applied: [] }

  const steps: DocMigration[] = [...(def.migrations ?? [])]
    .filter((m) => m.to > state.schema && m.to <= target)
    .sort((a, b) => a.to - b.to)

  let cur = state
  const applied: number[] = []
  for (const step of steps) {
    cur = step.up(cur)
    cur = { ...cur, schema: step.to }
    applied.push(step.to)
  }
  if (cur.schema !== target) cur = { ...cur, schema: target }
  return { state: cur, status: applied.length > 0 ? 'migrated' : 'ok', readOnly: false, applied }
}
