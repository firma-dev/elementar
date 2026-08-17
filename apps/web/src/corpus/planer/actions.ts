import { seriesRecordId } from '@elementar/core'
import type { DocCore, JsonValue, LocalDate, RecordId } from '@elementar/core'
import type { DocHandle } from '../../runtime/index.js'
import { LISTS, listBucket } from './schema.js'
import type { ListKey, PlanerCollections, Project, Repeat, Task } from './schema.js'
import { addDays, todayDate } from './dates.js'
import { S } from './strings.js'

export type PlanerDoc = DocCore<PlanerCollections>
export type PlanerHandle = DocHandle<PlanerCollections>

export interface NewTask {
  title: string
  bucket: string
  date?: LocalDate | null
  time?: string | null
}

export function addTask(doc: PlanerDoc, init: NewTask): RecordId | null {
  const title = init.title.trim()
  if (title === '') return null
  let id: RecordId | null = null
  doc.tx(
    (t) => {
      id = t.col.task.create(
        {
          title,
          bucket: init.bucket,
          date: init.date ?? null,
          time: init.time ?? null,
        },
        { group: init.bucket, at: 'end' },
      )
    },
    { label: `${S.composer.submit}: ${title}` },
  )
  return id
}

/** Следующая дата серии по правилу повтора. */
export function nextRepeatDate(from: LocalDate, repeat: Repeat): LocalDate {
  const step = Math.min(30, Math.max(1, Math.trunc(repeat.interval)))
  if (repeat.every === 'day') return addDays(from, step)
  if (repeat.every === 'week') {
    const days = repeat.weekdays
    if (days !== undefined && days.length > 0) {
      for (let i = 1; i <= 7 * step; i += 1) {
        const candidate = addDays(from, i)
        const wd = new Date(candidate).getDay()
        const iso = wd === 0 ? 7 : wd
        if (days.includes(iso)) return candidate
      }
    }
    return addDays(from, 7 * step)
  }
  const base = new Date(from)
  base.setMonth(base.getMonth() + step)
  return base.toISOString().slice(0, 10)
}

/**
 * Переключение выполнения. Для повторяемой задачи создаётся следующее вхождение
 * с детерминированным id (§6.9): два устройства, закрывшие её одновременно, получат
 * одну запись, а не две.
 */
export function toggleTask(doc: PlanerDoc, task: Task, at: number = Date.now()): void {
  const done = !task.done
  doc.tx(
    (t) => {
      t.col.task.update(task.id, { done, doneAt: done ? at : null } as Partial<Task>)
      const repeat = task.repeat
      if (!done || repeat == null || task.date == null || task.date === '') return
      const seriesId = task.seriesId ?? task.id
      const index = (task.occurrenceIndex ?? 0) + 1
      t.col.task.create(
        {
          title: task.title,
          note: task.note,
          bucket: task.bucket,
          date: nextRepeatDate(task.date, repeat),
          time: task.time,
          repeat,
          seriesId,
          occurrenceIndex: index,
        } as Partial<Task>,
        { group: task.bucket, at: 'end' },
        seriesRecordId(seriesId, index),
      )
    },
    { label: done ? S.task.done : S.task.undone },
  )
}

export function updateTask(doc: PlanerDoc, id: RecordId, patch: Partial<Task>, label?: string): void {
  doc.tx(
    (t) => {
      t.col.task.update(id, patch)
    },
    { label: label ?? S.common.save },
  )
}

export function postponeTask(doc: PlanerDoc, task: Task, days = 1): void {
  const base = task.date == null || task.date === '' ? todayDate() : task.date
  updateTask(doc, task.id, { date: addDays(base, days) } as Partial<Task>, S.task.tomorrowAction)
}

export function removeTask(doc: PlanerDoc, id: RecordId): void {
  doc.tx(
    (t) => {
      t.col.task.remove(id)
    },
    { label: S.task.delete },
  )
}

export function restoreTask(doc: PlanerDoc, id: RecordId): void {
  doc.tx(
    (t) => {
      t.col.task.restore(id)
    },
    { label: S.trash.restore },
  )
}

export function moveTask(doc: PlanerDoc, id: RecordId, bucket: string): void {
  doc.tx(
    (t) => {
      t.col.task.update(id, { bucket } as Partial<Task>)
      t.col.task.move(id, { group: bucket, at: 'end' })
    },
    { label: S.task.moveTo },
  )
}

/** Перестановка внутри контейнера: beforeId === null — в конец. */
export function reorderTask(doc: PlanerDoc, id: RecordId, beforeId: RecordId | null): void {
  doc.tx(
    (t) => {
      t.col.task.move(id, beforeId === null ? { at: 'end' } : { before: beforeId })
    },
    { label: 'Порядок' },
  )
}

export function resolveNoteConflict(doc: PlanerDoc, id: RecordId, value: string): void {
  doc.tx(
    (t) => {
      t.col.task.resolveConflict(id, 'note', value)
    },
    { label: S.task.notePlaceholder },
  )
}

export function addProject(doc: PlanerDoc, title: string): RecordId | null {
  const clean = title.trim()
  if (clean === '') return null
  let id: RecordId | null = null
  doc.tx(
    (t) => {
      id = t.col.project.create({ title: clean }, { at: 'end' })
    },
    { label: S.project.add },
  )
  return id
}

export function updateProject(doc: PlanerDoc, id: RecordId, patch: Partial<Project>): void {
  doc.tx(
    (t) => {
      t.col.project.update(id, patch)
    },
    { label: S.common.save },
  )
}

export function removeProject(doc: PlanerDoc, id: RecordId): void {
  doc.tx(
    (t) => {
      t.col.project.remove(id)
    },
    { label: S.project.delete },
  )
}

export function setMeta(doc: PlanerDoc, patch: Record<string, JsonValue>): void {
  doc.tx(
    (t) => {
      t.meta(patch)
    },
    { label: S.settings.heading },
  )
}

export function renameList(doc: PlanerDoc, list: ListKey, title: string): void {
  const current = doc.meta.value['listTitles']
  const map: Record<string, string> =
    typeof current === 'object' && current !== null ? { ...(current as Record<string, string>) } : {}
  map[list] = title
  setMeta(doc, { listTitles: map })
}

/** Пустой планер: четыре списка существуют всегда, поэтому засевать нечего, кроме имени. */
export function seedTitles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of LISTS) out[key] = S.lists[key]
  return out
}

export function defaultBucket(): string {
  return listBucket('work')
}
