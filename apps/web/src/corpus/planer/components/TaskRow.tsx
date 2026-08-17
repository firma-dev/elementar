import type { JSX } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { Checkbox, IconButton, Menu, Row, toast } from '@elementar/ui'
import type { MenuEntry, Tone } from '@elementar/ui'
import { parseTagged } from '@elementar/core'
import type { RecordId } from '@elementar/core'
import { LISTS } from '../schema.js'
import type { ListKey, Project, Task } from '../schema.js'
import { formatRelativeDay } from '../dates.js'
import { S } from '../strings.js'
import { postponeTask, removeTask, toggleTask } from '../actions.js'
import type { PlanerStore } from '../store.js'

export function toneOfBucket(bucket: string, projects?: Map<RecordId, Project>): Tone {
  const tag = parseTagged(bucket)
  if (tag.variant === 'list' && LISTS.includes(tag.value as ListKey)) return tag.value as Tone
  if (tag.variant === 'proj') {
    const tint = projects?.get(tag.value as RecordId)?.tint
    if (tint !== undefined && tint !== 'neutral') return tint as Tone
  }
  return 'neutral'
}

export interface TaskRowProps {
  task: Task
  store: PlanerStore
  /** Показывать точку контейнера: только там, где контейнеры смешаны (§12.6). */
  showDot?: boolean
  containerLabel?: string
  projects?: Map<RecordId, Project>
}

const DOTS = (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d="M5 10h.01M10 10h.01M15 10h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
  </svg>
)

export function TaskRow({ task, store, showDot, containerLabel, projects }: TaskRowProps): JSX.Element {
  const doc = store.doc
  const [menuOpen, setMenuOpen] = useState(false)
  // ref вешается на обёртку: preact не пробрасывает ref в функциональный компонент
  const anchor = useRef<HTMLSpanElement | null>(null)
  const tone = toneOfBucket(task.bucket, projects)

  const subtitleParts: string[] = []
  if (task.date != null && task.date !== '') subtitleParts.push(formatRelativeDay(task.date, store.today.value))
  if (task.time != null && task.time !== '') subtitleParts.push(task.time)
  if (containerLabel !== undefined && containerLabel !== '') subtitleParts.push(containerLabel)

  const remove = (): void => {
    removeTask(doc, task.id)
    toast.show({
      message: `«${task.title}» удалена`,
      tone: 'neutral',
      action: {
        label: S.agent.undo,
        onAction: () => {
          doc.undo.undo()
        },
      },
    })
  }

  const items: MenuEntry[] = [
    {
      id: 'toggle',
      label: task.done ? S.task.undone : S.task.done,
      onSelect: () => toggleTask(doc, task),
    },
    {
      id: 'tomorrow',
      label: S.task.tomorrowAction,
      onSelect: () => postponeTask(doc, task),
    },
    {
      id: 'open',
      label: S.task.openCard,
      onSelect: () => store.openTask(task.id),
    },
    { type: 'separator' },
    { id: 'delete', label: S.task.delete, tone: 'danger', onSelect: remove },
  ]

  return (
    <>
      <Row
        tone={showDot === true ? tone : undefined}
        muted={task.done}
        title={<span class="p-task__title">{task.title}</span>}
        subtitle={subtitleParts.length === 0 ? undefined : subtitleParts.join(' · ')}
        onActivate={() => store.openTask(task.id)}
        leading={
          <Checkbox
            checked={task.done}
            ariaLabel={task.done ? S.task.undone : S.task.done}
            tone={tone}
            onCheckedChange={() => toggleTask(doc, task)}
          />
        }
        trailing={
          <span ref={anchor}>
            <IconButton
              label={S.task.rowMenu}
              icon={DOTS}
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(true)
              }}
            />
          </span>
        }
        swipe={{
          right: {
            label: task.done ? S.task.undone : S.task.done,
            icon: '✓',
            tone: 'success',
            onAction: () => toggleTask(doc, task),
          },
          left: [
            { label: S.task.tomorrowAction, icon: '→', tone: 'accent', onAction: () => postponeTask(doc, task) },
            { label: S.task.delete, icon: '✕', tone: 'danger', onAction: remove },
          ],
        }}
      />
      <Menu
        items={items}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchor={anchor.current}
        ariaLabel={S.task.rowMenu}
      />
    </>
  )
}
