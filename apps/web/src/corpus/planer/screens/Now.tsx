import type { JSX } from 'preact'
import { EmptyState, ListView } from '@elementar/ui'
import { S } from '../strings.js'
import { Section } from '../components/Section.js'
import { TaskRow } from '../components/TaskRow.js'
import { projectIndex } from '../select.js'
import type { Task } from '../schema.js'
import type { PlanerStore } from '../store.js'

export interface ScreenProps {
  store: PlanerStore
}

/**
 * «Сейчас»: просрочено → сегодня → сделано сегодня. Единственный экран, где контейнеры
 * смешаны, поэтому строки несут точку цвета контейнера (§12.6).
 */
export function NowScreen({ store }: ScreenProps): JSX.Element {
  const buckets = store.nowBuckets.value
  const projects = projectIndex(store.doc)
  const empty = buckets.overdue.length === 0 && buckets.today.length === 0 && buckets.doneToday.length === 0

  const rows = (items: readonly Task[], label: string): JSX.Element => (
    <ListView
      items={items}
      getKey={(t) => t.id}
      ariaLabel={label}
      renderItem={(t) => <TaskRow task={t} store={store} showDot projects={projects} />}
    />
  )

  if (empty)
    return (
      <EmptyState
        size="page"
        title={S.now.emptyTitle}
        action={{ label: S.now.emptyAction, onAction: () => (store.tab.value = 'lists') }}
      />
    )

  return (
    <div class="p-screen">
      {buckets.overdue.length === 0 ? null : (
        <Section title={S.now.overdue} count={buckets.overdue.length} tone="danger">
          {rows(buckets.overdue, S.now.overdue)}
        </Section>
      )}
      {buckets.today.length === 0 ? null : (
        <Section title={S.now.today} count={buckets.today.length}>
          {rows(buckets.today, S.now.today)}
        </Section>
      )}
      {buckets.doneToday.length === 0 ? null : (
        <Section title={S.now.doneToday} count={buckets.doneToday.length} collapsible defaultOpen={false}>
          {rows(buckets.doneToday, S.now.doneToday)}
        </Section>
      )}
    </div>
  )
}
