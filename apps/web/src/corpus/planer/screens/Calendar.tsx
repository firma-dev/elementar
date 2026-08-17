import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { Button, EmptyState, Field, IconButton, ListView } from '@elementar/ui'
import type { LocalDate } from '@elementar/core'
import type { Task } from '../schema.js'
import { S } from '../strings.js'
import {
  addDays,
  daysOfMonth,
  formatDay,
  monthKey,
  monthTitle,
  shiftMonth,
  startOfWeek,
  weekdayOf,
} from '../dates.js'
import { calendarMonth, projectIndex } from '../select.js'
import { TaskRow, toneOfBucket } from '../components/TaskRow.js'
import { addTask } from '../actions.js'
import type { PlanerStore } from '../store.js'

function weekStartOf(store: PlanerStore): 1 | 7 {
  return store.doc.meta.value['weekStart'] === '7' ? 7 : 1
}

function weekdayLabels(weekStart: 1 | 7): string[] {
  const base = [...S.calendar.weekdays]
  return weekStart === 1 ? base : [base[6] ?? 'Вс', ...base.slice(0, 6)]
}

/** Сетка месяца: недели по строкам, начиная с выбранного дня недели. */
function gridOf(month: string, weekStart: 1 | 7): LocalDate[] {
  const days = daysOfMonth(month)
  const first = days[0]
  if (first === undefined) return []
  const start = startOfWeek(first, weekStart)
  const out: LocalDate[] = []
  const last = days[days.length - 1] ?? first
  let cursor = start
  while (cursor <= last || out.length % 7 !== 0) {
    out.push(cursor)
    cursor = addDays(cursor, 1)
    if (out.length > 42) break
  }
  return out
}

/**
 * Календарь (§12.6): месячная сетка, до трёх задач в ячейке, «+N» дальше.
 * Часовых сеток нет — планер про дни.
 */
export function CalendarScreen({ store }: { store: PlanerStore }): JSX.Element {
  const [selected, setSelected] = useState<LocalDate | null>(null)
  const [draft, setDraft] = useState('')
  const month = store.month.value
  const weekStart = weekStartOf(store)
  const byDay = calendarMonth(store.doc, month)
  const projects = projectIndex(store.doc)
  const today = store.today.value
  const days = gridOf(month, weekStart)
  const dayTasks = selected === null ? [] : (byDay.get(selected) ?? [])

  // двойной тап по дате — создать задачу на этот день (§12.4): поле появляется под сеткой
  const createOnDay = (day: LocalDate): void => {
    setSelected(day)
    setDraft('')
  }

  const submitDraft = (): void => {
    if (selected === null || draft.trim() === '') return
    addTask(store.doc, { title: draft, bucket: store.composerBucket.value, date: selected })
    setDraft('')
  }

  return (
    <div class="p-screen p-calendar">
      <div class="p-calendar__head">
        <IconButton label="Предыдущий месяц" icon="‹" onClick={() => (store.month.value = shiftMonth(month, -1))} />
        <h2 class="e-heading">{monthTitle(month)}</h2>
        <IconButton label="Следующий месяц" icon="›" onClick={() => (store.month.value = shiftMonth(month, 1))} />
        {month === monthKey(today) ? null : (
          <Button size="sm" onClick={() => (store.month.value = monthKey(today))}>
            {S.calendar.today}
          </Button>
        )}
      </div>

      <div class="p-calendar__weekdays e-caption" aria-hidden="true">
        {weekdayLabels(weekStart).map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div class="p-calendar__grid" role="grid" aria-label={S.calendar.heading}>
        {days.map((day) => {
          const tasks = byDay.get(day) ?? []
          const outside = !day.startsWith(month)
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              class="p-calendar__day"
              data-today={day === today ? '1' : undefined}
              data-outside={outside ? '1' : undefined}
              data-selected={day === selected ? '1' : undefined}
              aria-label={`${formatDay(day)}, задач: ${tasks.length}`}
              onClick={() => setSelected(day)}
              onDblClick={() => createOnDay(day)}
            >
              <span class="p-calendar__num e-num">{Number(day.slice(8))}</span>
              <span class="p-calendar__dots" aria-hidden="true">
                {tasks.slice(0, 4).map((t: Task) => (
                  <i key={t.id} class="p-calendar__dot" data-tone={toneOfBucket(t.bucket, projects)} />
                ))}
              </span>
              <span class="p-calendar__titles" aria-hidden="true">
                {tasks.slice(0, 3).map((t: Task) => (
                  <span key={t.id} class="e-truncate" data-tone={toneOfBucket(t.bucket, projects)}>
                    {t.title}
                  </span>
                ))}
                {tasks.length > 3 ? <span class="e-caption">{S.calendar.more(tasks.length - 3)}</span> : null}
              </span>
            </button>
          )
        })}
      </div>

      {selected === null ? null : (
        <Field
          class="p-calendar__new"
          value={draft}
          onValueChange={setDraft}
          ariaLabel={S.calendar.newOnDay}
          placeholder={`${S.calendar.newOnDay}: ${formatDay(selected)}`}
          onEnter={submitDraft}
          onEscape={() => setDraft('')}
        />
      )}

      {selected === null ? null : dayTasks.length === 0 ? (
        <EmptyState size="inline" title={formatDay(selected)} description={S.list.emptyHint} />
      ) : (
        <ListView
          items={dayTasks}
          getKey={(t: Task) => t.id}
          ariaLabel={formatDay(selected)}
          header={<div class="e-overline">{`${formatDay(selected)} · ${S.calendar.weekdays[weekdayOf(selected) - 1] ?? ''}`}</div>}
          renderItem={(t: Task) => <TaskRow task={t} store={store} showDot projects={projects} />}
        />
      )}
    </div>
  )
}

export default CalendarScreen
