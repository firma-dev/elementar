import { ORPHAN, parseTagged } from '@elementar/core'
import type { Collection, LocalDate, RecordId } from '@elementar/core'
import { LISTS, listBucket, projectBucket } from './schema.js'
import type { ListKey, Project, Task } from './schema.js'
import { startOfDayMs, todayDate } from './dates.js'

/** Всё, что нужно выборкам: и DocCore, и DocHandle подходят структурно. */
export interface PlanerDocLike {
  readonly col: {
    readonly task: Collection<Task>
    readonly project: Collection<Project>
  }
}

export interface DayBuckets {
  overdue: Task[]
  today: Task[]
  doneToday: Task[]
}

export interface ListBuckets {
  open: Task[]
  doneToday: Task[]
}

function byTime(a: Task, b: Task): number {
  const at = a.time ?? ''
  const bt = b.time ?? ''
  if (at === bt) return 0
  if (at === '') return 1
  if (bt === '') return -1
  return at < bt ? -1 : 1
}

function byDoneAt(a: Task, b: Task): number {
  return (b.doneAt ?? 0) - (a.doneAt ?? 0)
}

export function isDoneToday(task: Task, today: LocalDate): boolean {
  if (!task.done) return false
  const at = task.doneAt
  if (at == null) return false
  const start = startOfDayMs(today)
  return at >= start && at < start + 864e5
}

/** Живые проекты по id: по ним решается, не висячий ли контейнер (§3.5). */
export function projectIndex(doc: PlanerDocLike): Map<RecordId, Project> {
  const out = new Map<RecordId, Project>()
  for (const p of doc.col.project.all.value) out.set(p.id, p)
  return out
}

/** Контейнер с учётом висячих ссылок и архива. */
export function effectiveBucket(task: Task, projects: Map<RecordId, Project>): string {
  const tag = parseTagged(task.bucket)
  if (tag.variant !== 'proj') return task.bucket
  return projects.has(tag.value as RecordId) ? task.bucket : ORPHAN
}

function inArchivedProject(task: Task, projects: Map<RecordId, Project>): boolean {
  const tag = parseTagged(task.bucket)
  if (tag.variant !== 'proj') return false
  return projects.get(tag.value as RecordId)?.archived === true
}

/** «Сейчас»: просрочено → сегодня → сделано сегодня. Задачи архивных проектов не показываются. */
export function todayTasks(doc: PlanerDocLike, today: LocalDate = todayDate()): DayBuckets {
  const projects = projectIndex(doc)
  const out: DayBuckets = { overdue: [], today: [], doneToday: [] }
  for (const task of doc.col.task.all.value) {
    if (inArchivedProject(task, projects)) continue
    if (isDoneToday(task, today)) {
      out.doneToday.push(task)
      continue
    }
    if (task.done) continue
    const date = task.date
    if (date == null || date === '') continue
    if (date < today) out.overdue.push(task)
    else if (date === today) out.today.push(task)
  }
  out.overdue.sort((a, b) => (a.date === b.date ? byTime(a, b) : (a.date ?? '') < (b.date ?? '') ? -1 : 1))
  out.today.sort(byTime)
  out.doneToday.sort(byDoneAt)
  return out
}

export function listTasks(doc: PlanerDocLike, list: ListKey, today: LocalDate = todayDate()): ListBuckets {
  const bucket = listBucket(list)
  const out: ListBuckets = { open: [], doneToday: [] }
  for (const task of doc.col.task.all.value) {
    if (task.bucket !== bucket) continue
    if (isDoneToday(task, today)) out.doneToday.push(task)
    else if (!task.done) out.open.push(task)
  }
  out.doneToday.sort(byDoneAt)
  return out
}

export function projectTasks(
  doc: PlanerDocLike,
  projectId: RecordId,
  today: LocalDate = todayDate(),
): ListBuckets {
  const bucket = projectBucket(projectId)
  const out: ListBuckets = { open: [], doneToday: [] }
  for (const task of doc.col.task.all.value) {
    if (task.bucket !== bucket) continue
    if (isDoneToday(task, today)) out.doneToday.push(task)
    else if (!task.done) out.open.push(task)
  }
  out.doneToday.sort(byDoneAt)
  return out
}

/** Задачи, чей контейнер указывает на мёртвый проект (§3.5). Ячейка при этом не меняется. */
export function orphanTasks(doc: PlanerDocLike): Task[] {
  const projects = projectIndex(doc)
  return doc.col.task.all.value.filter(
    (t) => !t.done && effectiveBucket(t, projects) === ORPHAN,
  )
}

export function calendarMonth(doc: PlanerDocLike, month: string): Map<LocalDate, Task[]> {
  const out = new Map<LocalDate, Task[]>()
  const projects = projectIndex(doc)
  for (const task of doc.col.task.all.value) {
    const date = task.date
    if (date == null || !date.startsWith(month)) continue
    if (inArchivedProject(task, projects)) continue
    const day = out.get(date)
    if (day === undefined) out.set(date, [task])
    else day.push(task)
  }
  for (const day of out.values()) day.sort(byTime)
  return out
}

/** Счётчики четырёх списков: только открытые задачи. */
export function counts(doc: PlanerDocLike): Record<ListKey, number> {
  const out = { work: 0, home: 0, hobby: 0, craft: 0 }
  for (const task of doc.col.task.all.value) {
    if (task.done) continue
    const tag = parseTagged(task.bucket)
    if (tag.variant !== 'list') continue
    const key = tag.value as ListKey
    if (LISTS.includes(key)) out[key] += 1
  }
  return out
}

export function openCount(doc: PlanerDocLike, today: LocalDate = todayDate()): number {
  const day = todayTasks(doc, today)
  return day.overdue.length + day.today.length
}

export function searchTasks(doc: PlanerDocLike, query: string): Task[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return doc.col.task.all.value
    .filter((t) => t.title.toLowerCase().includes(q) || t.note.toLowerCase().includes(q))
    .slice(0, 50)
}

/** Прогресс проекта: сделано из всего (для карточки). */
export function projectProgress(doc: PlanerDocLike, projectId: RecordId): { done: number; total: number } {
  const bucket = projectBucket(projectId)
  let done = 0
  let total = 0
  for (const task of doc.col.task.all.value) {
    if (task.bucket !== bucket) continue
    total += 1
    if (task.done) done += 1
  }
  return { done, total }
}
