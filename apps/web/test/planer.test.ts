import { describe, expect, it } from 'vitest'
import { actorId, createDocCore } from '@elementar/core'
import type { DocCore } from '@elementar/core'
import { LISTS, PLANER, listBucket, projectBucket } from '../src/corpus/planer/schema.js'
import type { PlanerCollections } from '../src/corpus/planer/schema.js'
import { addTask, nextRepeatDate, toggleTask } from '../src/corpus/planer/actions.js'
import {
  calendarMonth,
  counts,
  listTasks,
  openCount,
  orphanTasks,
  projectTasks,
  todayTasks,
} from '../src/corpus/planer/select.js'
import { addDays, parseComposer } from '../src/corpus/planer/dates.js'
import { S, listTitle } from '../src/corpus/planer/strings.js'

const TODAY = '2026-08-16'

function makeDoc(): DocCore<PlanerCollections> {
  return createDocCore<PlanerCollections>({ def: PLANER, docId: 'TEST', actor: actorId() })
}

describe('схема планера', () => {
  it('единственный контейнер — bucket, и он groupBy', () => {
    expect(PLANER.collections.task.groupBy).toBe('bucket')
    expect(PLANER.collections.task.fields['bucket']?.kind).toBe('tagged')
    expect(PLANER.collections.task.fields['bucket']?.onDangling).toBe('orphan')
    expect(Object.keys(PLANER.collections)).toEqual(['task', 'project'])
  })

  it('note хранит проигравшие версии, а title — нет (§6.6a)', () => {
    expect(PLANER.collections.task.fields['note']?.keepConflicts).toBe(true)
    expect(PLANER.collections.task.fields['title']?.keepConflicts).toBe(false)
  })

  it('мягкое удаление 30 дней и холодная часть по doneAt', () => {
    expect(PLANER.collections.task.softDeleteDays).toBe(30)
    const cold = PLANER.collections.task.cold
    expect(cold).toBeDefined()
    const rec = { done: true, doneAt: 0 } as never
    expect(cold?.(rec, 91 * 864e5)).toBe(true)
    expect(cold?.(rec, 10 * 864e5)).toBe(false)
  })
})

describe('выборки', () => {
  it('«Сейчас»: просрочено, сегодня, сделано сегодня', () => {
    const doc = makeDoc()
    addTask(doc, { title: 'вчера', bucket: listBucket('work'), date: addDays(TODAY, -1) })
    addTask(doc, { title: 'сегодня в 9', bucket: listBucket('home'), date: TODAY, time: '09:00' })
    addTask(doc, { title: 'сегодня без времени', bucket: listBucket('home'), date: TODAY })
    addTask(doc, { title: 'завтра', bucket: listBucket('hobby'), date: addDays(TODAY, 1) })

    const day = todayTasks(doc, TODAY)
    expect(day.overdue.map((t) => t.title)).toEqual(['вчера'])
    expect(day.today.map((t) => t.title)).toEqual(['сегодня в 9', 'сегодня без времени'])
    expect(day.doneToday).toHaveLength(0)
    expect(openCount(doc, TODAY)).toBe(3)
  })

  it('выполненная сегодня уходит в свою секцию и не считается открытой', () => {
    const doc = makeDoc()
    addTask(doc, { title: 'закрыть', bucket: listBucket('work'), date: TODAY })
    const task = doc.col.task.all.value[0]
    expect(task).toBeDefined()
    if (task === undefined) return
    const noon = new Date(`${TODAY}T12:00:00`).getTime()
    toggleTask(doc, task, noon)

    const day = todayTasks(doc, TODAY)
    expect(day.today).toHaveLength(0)
    expect(day.doneToday.map((t) => t.title)).toEqual(['закрыть'])
    expect(counts(doc)['work']).toBe(0)
  })

  it('счётчики считают только открытые задачи по спискам', () => {
    const doc = makeDoc()
    for (const list of LISTS) addTask(doc, { title: list, bucket: listBucket(list) })
    expect(counts(doc)).toEqual({ work: 1, home: 1, hobby: 1, craft: 1 })
    expect(listTasks(doc, 'craft', TODAY).open.map((t) => t.title)).toEqual(['craft'])
  })

  it('задача мёртвого проекта попадает в «Без проекта», ячейка не меняется', () => {
    const doc = makeDoc()
    let projectId = ''
    doc.tx((t) => {
      projectId = t.col.project.create({ title: 'Переезд' })
    })
    addTask(doc, { title: 'коробки', bucket: projectBucket(projectId as never) })
    expect(projectTasks(doc, projectId as never, TODAY).open).toHaveLength(1)
    expect(orphanTasks(doc)).toHaveLength(0)

    doc.tx((t) => {
      t.col.project.remove(projectId as never)
    })
    const orphans = orphanTasks(doc)
    expect(orphans).toHaveLength(1)
    expect(orphans[0]?.bucket).toBe(projectBucket(projectId as never))
  })

  it('календарь раскладывает задачи по датам месяца', () => {
    const doc = makeDoc()
    addTask(doc, { title: 'а', bucket: listBucket('work'), date: '2026-08-03' })
    addTask(doc, { title: 'б', bucket: listBucket('work'), date: '2026-08-03', time: '08:00' })
    addTask(doc, { title: 'в', bucket: listBucket('work'), date: '2026-09-01' })
    const month = calendarMonth(doc, '2026-08')
    expect([...month.keys()]).toEqual(['2026-08-03'])
    expect(month.get('2026-08-03')?.map((t) => t.title)).toEqual(['б', 'а'])
  })
})

describe('повторы', () => {
  it('следующая дата по правилу', () => {
    expect(nextRepeatDate('2026-08-16', { every: 'day', interval: 1 })).toBe('2026-08-17')
    expect(nextRepeatDate('2026-08-16', { every: 'week', interval: 1 })).toBe('2026-08-23')
    expect(nextRepeatDate('2026-08-16', { every: 'week', interval: 1, weekdays: [2] })).toBe('2026-08-18')
  })

  it('выполнение повторяемой задачи создаёт следующее вхождение с детерминированным id', () => {
    const doc = makeDoc()
    addTask(doc, { title: 'мусор', bucket: listBucket('home'), date: TODAY })
    const first = doc.col.task.all.value[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    doc.tx((t) => {
      t.col.task.update(first.id, { repeat: { every: 'week', interval: 1, weekdays: [2] } } as never)
    })
    const withRepeat = doc.col.task.byId(first.id).value
    expect(withRepeat).toBeDefined()
    if (withRepeat === undefined) return
    toggleTask(doc, withRepeat, Date.now())

    const open = doc.col.task.all.value.filter((t) => !t.done)
    expect(open).toHaveLength(1)
    expect(open[0]?.occurrenceIndex).toBe(1)
    expect(open[0]?.seriesId).toBe(first.id)
    expect(open[0]?.date).toBe('2026-08-18')
  })
})

describe('композер', () => {
  it('разбирает даты словами и цифрами', () => {
    expect(parseComposer('позвонить завтра', TODAY)).toEqual({
      title: 'позвонить',
      date: '2026-08-17',
      time: null,
    })
    expect(parseComposer('оплатить 12.09', TODAY).date).toBe('2026-09-12')
    expect(parseComposer('встреча пн в 9:30', TODAY)).toEqual({
      title: 'встреча',
      date: '2026-08-17',
      time: '09:30',
    })
  })

  it('восклицательный знак ничего не делает — приоритетов нет', () => {
    const parsed = parseComposer('срочно!!!', TODAY)
    expect(parsed.title).toBe('срочно!!!')
    expect(parsed.date).toBeNull()
  })

  it('пустой ввод не создаёт задачу', () => {
    const doc = makeDoc()
    expect(addTask(doc, { title: '   ', bucket: listBucket('work') })).toBeNull()
    expect(doc.col.task.count.value).toBe(0)
  })
})

describe('строки', () => {
  it('переименование списка перекрывает значение по умолчанию', () => {
    expect(listTitle('home')).toBe(S.lists.home)
    expect(listTitle('home', { home: 'Дом' })).toBe('Дом')
    expect(listTitle('home', { home: '  ' })).toBe(S.lists.home)
  })
})
