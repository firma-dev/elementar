import type { JSX } from 'preact'
import { EmptyState, ListView, Tabs } from '@elementar/ui'
import type { TabItem } from '@elementar/ui'
import type { RecordId } from '@elementar/core'
import { LISTS } from '../schema.js'
import type { ListKey, Task } from '../schema.js'
import { S, listTitle } from '../strings.js'
import { Section } from '../components/Section.js'
import { TaskRow } from '../components/TaskRow.js'
import { reorderTask } from '../actions.js'
import { projectIndex } from '../select.js'
import type { PlanerStore } from '../store.js'

export interface ScreenProps {
  store: PlanerStore
}

export function customTitles(store: PlanerStore): Record<string, string> | null {
  const raw = store.doc.meta.value['listTitles']
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, string>) : null
}

/** Четыре списка сегментами: пятая вкладка снизу ломает достижимость большим пальцем. */
export function ListsScreen({ store }: ScreenProps): JSX.Element {
  const titles = customTitles(store)
  const counts = store.listCounts.value
  const buckets = store.listBuckets.value
  const orphans = store.orphans.value
  const projects = projectIndex(store.doc)

  const items: TabItem[] = LISTS.map((key: ListKey) => ({
    id: key,
    label: listTitle(key, titles),
    badge: counts[key] === 0 ? undefined : counts[key],
    tone: key,
  }))

  const onReorder = (key: string, beforeKey: string | null): void => {
    reorderTask(store.doc, key as RecordId, beforeKey as RecordId | null)
  }

  return (
    <div class="p-screen" data-tone={store.list.value}>
      <Tabs
        class="p-lists__tabs"
        items={items}
        value={store.list.value}
        ariaLabel={S.nav.lists}
        onValueChange={(id) => (store.list.value = id as ListKey)}
      />
      {buckets.open.length === 0 && buckets.doneToday.length === 0 ? (
        <EmptyState size="page" title={S.list.emptyTitle} description={S.list.emptyHint} />
      ) : (
        <>
          <ListView
            items={buckets.open}
            getKey={(t: Task) => t.id}
            ariaLabel={listTitle(store.list.value, titles)}
            reorder={{ onReorder, handle: 'row' }}
            flip
            renderItem={(t: Task) => <TaskRow task={t} store={store} projects={projects} />}
          />
          {buckets.doneToday.length === 0 ? null : (
            <Section title={S.now.doneToday} count={buckets.doneToday.length} collapsible defaultOpen={false}>
              <ListView
                items={buckets.doneToday}
                getKey={(t: Task) => t.id}
                ariaLabel={S.now.doneToday}
                renderItem={(t: Task) => <TaskRow task={t} store={store} projects={projects} />}
              />
            </Section>
          )}
        </>
      )}
      {orphans.length === 0 ? null : (
        <Section title={S.list.orphan} count={orphans.length} collapsible defaultOpen={false}>
          <ListView
            items={orphans}
            getKey={(t: Task) => t.id}
            ariaLabel={S.list.orphan}
            renderItem={(t: Task) => <TaskRow task={t} store={store} projects={projects} />}
          />
        </Section>
      )}
    </div>
  )
}
