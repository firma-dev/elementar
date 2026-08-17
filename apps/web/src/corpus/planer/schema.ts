import { defineCorpus, f } from '@elementar/core'
import type { CorpusData, LocalDate, RecordId } from '@elementar/core'

export const LISTS = ['work', 'home', 'hobby', 'craft'] as const
export type ListKey = (typeof LISTS)[number]

/** Повтор задачи. Не RFC 5545: планер про дни, а не про встречи (§12.2). */
export type Repeat = {
  every: 'day' | 'week' | 'month'
  /** 1..30 */
  interval: number
  /** 1..7 (пн..вс), только для every: 'week' */
  weekdays?: number[]
}

export const PLANER = defineCorpus({
  id: 'planer',
  schemaVersion: 1,
  meta: {
    title: f.text({ max: 120 }),
    weekStart: f.enum(['1', '7'] as const, { default: '1' }),
    listTitles: f.json<Record<string, string>>(),
  },
  collections: {
    task: {
      ordered: true,
      groupBy: 'bucket',
      label: (t) => t.title,
      softDeleteDays: 30,
      cold: (t, now) => t.done && t.doneAt != null && now - t.doneAt > 90 * 864e5,
      fields: {
        title: f.text({ max: 400 }),
        note: f.text({ long: true }),
        /** ЕДИНСТВЕННЫЙ контейнер: 'list:work' | … | 'proj:<recordId>' (§3.4). */
        bucket: f.tagged({ list: {}, proj: { ref: 'project' } }, { default: 'list:work', onDangling: 'orphan' }),
        done: f.bool(false),
        doneAt: f.nullable(f.number()),
        date: f.nullable(f.date()),
        time: f.nullable(f.time()),
        repeat: f.nullable(f.json<Repeat>()),
        seriesId: f.nullable(f.ref('task', { onDangling: 'keep' })),
        occurrenceIndex: f.nullable(f.number()),
      },
    },
    project: {
      ordered: true,
      label: (p) => p.title,
      fields: {
        title: f.text({ max: 200 }),
        note: f.text({ long: true }),
        tint: f.enum([...LISTS, 'neutral'] as const, { default: 'neutral' }),
        due: f.nullable(f.date()),
        archived: f.bool(false),
      },
    },
  },
})

export type Planer = CorpusData<typeof PLANER>
export type Task = Planer['task']
export type Project = Planer['project']
export type PlanerCollections = (typeof PLANER)['collections']

export const BUCKET_LIST = 'list'
export const BUCKET_PROJECT = 'proj'

export function listBucket(list: ListKey): string {
  return `${BUCKET_LIST}:${list}`
}

export function projectBucket(id: RecordId): string {
  return `${BUCKET_PROJECT}:${id}`
}

/** 'YYYY-MM-DD' в местной зоне: дата без зоны, как договорились (ADR 0005). */
export function localDate(at: Date = new Date()): LocalDate {
  const y = at.getFullYear()
  const m = `${at.getMonth() + 1}`.padStart(2, '0')
  const d = `${at.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}
