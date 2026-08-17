import { computed, signal } from '@preact/signals'
import type { ReadonlySignal, Signal } from '@preact/signals'
import type { LocalDate, RecordId } from '@elementar/core'
import { listBucket } from './schema.js'
import type { ListKey, Task } from './schema.js'
import type { PlanerHandle } from './actions.js'
import { counts, listTasks, openCount, orphanTasks, projectTasks, todayTasks } from './select.js'
import type { DayBuckets, ListBuckets } from './select.js'
import { monthKey, todayDate } from './dates.js'

export type PlanerTab = 'now' | 'lists' | 'projects' | 'calendar'
export type PlanerOverlay = 'none' | 'trash' | 'settings' | 'share' | 'agent' | 'search' | 'digest'

export interface PlanerStore {
  readonly doc: PlanerHandle
  readonly tab: Signal<PlanerTab>
  readonly list: Signal<ListKey>
  readonly projectId: Signal<RecordId | null>
  readonly taskId: Signal<RecordId | null>
  readonly overlay: Signal<PlanerOverlay>
  readonly month: Signal<string>
  readonly today: Signal<LocalDate>
  readonly query: Signal<string>
  /** Контейнер, в который пишет композер прямо сейчас. */
  readonly composerBucket: ReadonlySignal<string>
  readonly nowBuckets: ReadonlySignal<DayBuckets>
  readonly listBuckets: ReadonlySignal<ListBuckets>
  readonly projectBuckets: ReadonlySignal<ListBuckets>
  readonly orphans: ReadonlySignal<readonly Task[]>
  readonly listCounts: ReadonlySignal<Record<ListKey, number>>
  readonly nowCount: ReadonlySignal<number>
  readonly selectedTask: ReadonlySignal<Task | undefined>
  openTask(id: RecordId | null): void
  openProject(id: RecordId | null): void
  show(overlay: PlanerOverlay): void
  refreshToday(): void
}

export function createStore(doc: PlanerHandle): PlanerStore {
  const today = signal<LocalDate>(todayDate())
  const tab = signal<PlanerTab>('now')
  const list = signal<ListKey>('work')
  const projectId = signal<RecordId | null>(null)
  const taskId = signal<RecordId | null>(null)
  const overlay = signal<PlanerOverlay>('none')
  const month = signal(monthKey(today.value))
  const query = signal('')

  const composerBucket = computed(() => {
    const project = projectId.value
    if (tab.value === 'projects' && project !== null) return `proj:${project}`
    return listBucket(list.value)
  })

  return {
    doc,
    tab,
    list,
    projectId,
    taskId,
    overlay,
    month,
    today,
    query,
    composerBucket,
    nowBuckets: computed(() => todayTasks(doc, today.value)),
    listBuckets: computed(() => listTasks(doc, list.value, today.value)),
    projectBuckets: computed(() => {
      const id = projectId.value
      return id === null ? { open: [], doneToday: [] } : projectTasks(doc, id, today.value)
    }),
    orphans: computed(() => orphanTasks(doc)),
    listCounts: computed(() => counts(doc)),
    nowCount: computed(() => openCount(doc, today.value)),
    selectedTask: computed(() => {
      const id = taskId.value
      return id === null ? undefined : doc.col.task.byId(id).value
    }),

    openTask(id): void {
      taskId.value = id
    },
    openProject(id): void {
      projectId.value = id
      if (id !== null) tab.value = 'projects'
    },
    show(next): void {
      overlay.value = next
    },
    refreshToday(): void {
      const now = todayDate()
      if (now !== today.value) today.value = now
    },
  }
}
