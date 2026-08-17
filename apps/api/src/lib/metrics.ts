/**
 * Суточные агрегаты (§8.2): ни одного docId, только счётчики. Копятся в памяти изолята
 * и сливаются кроном — писать строку D1 на каждый 404 под атакой означало бы платить
 * за чужой трафик дважды.
 */
import type { Catalog, MetricField } from './catalog.js'

const pending = new Map<MetricField, number>()

export function bumpMetric(field: MetricField, by = 1): void {
  pending.set(field, (pending.get(field) ?? 0) + by)
}

export function drainMetrics(): Array<[MetricField, number]> {
  const out = [...pending.entries()]
  pending.clear()
  return out
}

export async function flushMetrics(catalog: Catalog, day: string): Promise<void> {
  for (const [field, by] of drainMetrics()) {
    if (by > 0) await catalog.bumpMetric(day, field, by)
  }
}
