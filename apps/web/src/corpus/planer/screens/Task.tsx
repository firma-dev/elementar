import type { JSX } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Button, Chip, Field, Overlay } from '@elementar/ui'
import { C } from '@elementar/proto'
import { debounce, formatTagged, hlcActor, hlcWall, parseTagged } from '@elementar/core'
import type { ActorId, RecordId } from '@elementar/core'
import { formatLastSeen } from '@elementar/shell'
import { LISTS, listBucket, projectBucket } from '../schema.js'
import type { ListKey, Project, Repeat, Task } from '../schema.js'
import { S, listTitle } from '../strings.js'
import { addDays, formatDay, todayDate } from '../dates.js'
import { removeTask, resolveNoteConflict, toggleTask, updateTask } from '../actions.js'
import { customTitles } from './Lists.js'
import type { PlanerStore } from '../store.js'

function nameOf(store: PlanerStore, actor: ActorId): string {
  const rec = store.doc.actors.value.find((a) => a.id === actor)
  if (rec !== undefined && rec.name !== '') return rec.name
  return actor === store.doc.actor ? 'вы' : 'партнёр'
}

function containerLabel(store: PlanerStore, bucket: string): string {
  const tag = parseTagged(bucket)
  if (tag.variant === 'proj') {
    const p = store.doc.col.project.all.value.find((x: Project) => x.id === tag.value)
    return p?.title ?? S.list.orphan
  }
  return listTitle(tag.value as ListKey, customTitles(store))
}

/**
 * Карточка задачи (§12.7): шит на телефоне, панель на десктопе.
 * Сохранение по мере ввода с дебаунсом C.TEXT_DEBOUNCE_MS; кнопки «Сохранить» нет,
 * закрытие фиксирует немедленно.
 */
export function TaskSheet({ store }: { store: PlanerStore }): JSX.Element | null {
  const task = store.selectedTask.value
  const open = task !== undefined
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [showTime, setShowTime] = useState(false)
  const [showConflict, setShowConflict] = useState(false)
  const idRef = useRef<RecordId | null>(null)

  const saveTitle = useMemo(
    () =>
      debounce((value: string) => {
        const id = idRef.current
        if (id !== null) updateTask(store.doc, id, { title: value } as Partial<Task>)
      }, C.TEXT_DEBOUNCE_MS),
    [store],
  )
  const saveNote = useMemo(
    () =>
      debounce((value: string) => {
        const id = idRef.current
        if (id !== null) updateTask(store.doc, id, { note: value } as Partial<Task>)
      }, C.TEXT_DEBOUNCE_MS),
    [store],
  )

  useEffect(() => {
    if (task === undefined) return
    if (idRef.current === task.id) return
    idRef.current = task.id
    setTitle(task.title)
    setNote(task.note)
    setShowTime(task.time != null && task.time !== '')
  }, [task])

  if (task === undefined) return null

  const conflicts = store.doc.col.task.conflicts(task.id).value
  const noteConflicts = (conflicts.note ?? []) as unknown[]
  const today = store.today.value
  const titles = customTitles(store)

  const close = (): void => {
    saveTitle.flush()
    saveNote.flush()
    idRef.current = null
    store.openTask(null)
  }

  const setDate = (date: string | null): void => {
    updateTask(store.doc, task.id, { date } as Partial<Task>, S.task.date)
  }

  const setRepeat = (repeat: Repeat | null): void => {
    updateTask(store.doc, task.id, { repeat } as Partial<Task>, S.task.repeat)
  }

  const buckets: Array<{ id: string; label: string }> = [
    ...LISTS.map((k: ListKey) => ({ id: listBucket(k), label: listTitle(k, titles) })),
    ...store.doc.col.project.all.value
      .filter((p: Project) => !p.archived)
      .map((p: Project) => ({ id: projectBucket(p.id), label: p.title })),
  ]

  const createdBy = nameOf(store, hlcActor(task.createdAt))
  const updatedBy = nameOf(store, hlcActor(task.updatedAt))

  return (
    <Overlay
      open={open}
      onClose={close}
      title={S.task.openCard}
      size="md"
      detents={['content', 'full']}
    >
      <div class="e-stack p-task-sheet">
        <Field
          value={title}
          onValueChange={(v) => {
            setTitle(v)
            saveTitle(v)
          }}
          ariaLabel={S.task.titlePlaceholder}
          placeholder={S.task.titlePlaceholder}
          size="lg"
          multiline={{ minRows: 1, maxRows: 4 }}
          autoFocus
        />

        <Field
          value={note}
          onValueChange={(v) => {
            setNote(v)
            saveNote(v)
          }}
          ariaLabel={S.task.notePlaceholder}
          placeholder={S.task.notePlaceholder}
          multiline={{ minRows: 2, maxRows: 10 }}
        />

        {noteConflicts.length === 0 ? null : (
          <Chip
            label={S.task.conflictNote(updatedBy)}
            tone="warning"
            onSelect={() => setShowConflict(true)}
          />
        )}

        <div class="p-chips">
          {buckets.map((b) => (
            <Chip
              key={b.id}
              label={b.label}
              selected={task.bucket === b.id}
              onSelect={() =>
                updateTask(store.doc, task.id, { bucket: b.id } as Partial<Task>, S.task.moveTo)
              }
            />
          ))}
        </div>

        <div class="p-chips">
          <Chip label={S.task.today} selected={task.date === today} onSelect={() => setDate(today)} />
          <Chip
            label={S.task.tomorrow}
            selected={task.date === addDays(today, 1)}
            onSelect={() => setDate(addDays(today, 1))}
          />
          {task.date == null || task.date === '' ? null : (
            <Chip label={formatDay(task.date)} tone="accent" selected onRemove={() => setDate(null)} />
          )}
          <Chip label={S.task.clearDate} onSelect={() => setDate(null)} />
        </div>

        {showTime ? (
          <Field
            value={task.time ?? ''}
            onValueChange={(v) => updateTask(store.doc, task.id, { time: v } as Partial<Task>, S.task.time)}
            label={S.task.time}
            placeholder="09:30"
            inputMode="numeric"
          />
        ) : (
          <Button size="sm" onClick={() => setShowTime(true)}>
            {S.task.addTime}
          </Button>
        )}

        <div class="p-chips">
          <Chip label={S.task.repeatNone} selected={task.repeat == null} onSelect={() => setRepeat(null)} />
          <Chip
            label={S.task.repeatDay}
            selected={task.repeat?.every === 'day'}
            onSelect={() => setRepeat({ every: 'day', interval: 1 })}
          />
          <Chip
            label={S.task.repeatWeek}
            selected={task.repeat?.every === 'week'}
            onSelect={() => setRepeat({ every: 'week', interval: 1 })}
          />
          <Chip
            label={S.task.repeatMonth}
            selected={task.repeat?.every === 'month'}
            onSelect={() => setRepeat({ every: 'month', interval: 1 })}
          />
        </div>

        <div class="p-task-sheet__foot e-caption">
          <div>{S.task.createdBy(createdBy, formatLastSeen(hlcWall(task.createdAt)))}</div>
          <div>{S.task.changedBy(updatedBy, formatLastSeen(hlcWall(task.updatedAt)))}</div>
          <div>{containerLabel(store, formatTagged(parseTagged(task.bucket)))}</div>
        </div>

        <div class="p-task-sheet__actions">
          <Button onClick={() => toggleTask(store.doc, task)}>
            {task.done ? S.task.undone : S.task.done}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              removeTask(store.doc, task.id)
              close()
            }}
          >
            {S.task.delete}
          </Button>
        </div>
      </div>

      <Overlay
        open={showConflict}
        title={S.task.conflictNote(updatedBy)}
        onClose={() => setShowConflict(false)}
        size="sm"
      >
        <div class="e-stack">
          <div class="p-conflict">
            <div class="e-overline">{S.task.conflictKeepMine}</div>
            <p class="e-body">{note}</p>
            <Button onClick={() => setShowConflict(false)}>{S.task.conflictKeepMine}</Button>
          </div>
          {noteConflicts.map((value, i) => (
            <div class="p-conflict" key={i}>
              <div class="e-overline">{S.task.conflictNote(updatedBy)}</div>
              <p class="e-body">{String(value)}</p>
              <Button
                onClick={() => {
                  resolveNoteConflict(store.doc, task.id, String(value))
                  setNote(String(value))
                  setShowConflict(false)
                }}
              >
                {S.task.conflictKeepTheirs}
              </Button>
            </div>
          ))}
        </div>
      </Overlay>
    </Overlay>
  )
}
