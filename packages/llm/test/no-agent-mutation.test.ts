/**
 * Проверка правила §10.4: агент предлагает — человек подтверждает.
 * Тест сторожит именно границу: у контекста инструмента нет мутирующего API,
 * прогон агента не меняет документ, а результатом может быть только черновик.
 */
import { describe, expect, it } from 'vitest'
import { actorId, createDocCore, defineCorpus, f, recordId } from '@elementar/core'
import type { Op, ProposalDraft, RecordId } from '@elementar/core'
import {
  collectDrafts,
  createDocReadonly,
  createEchoProvider,
  draft,
  proposeTool,
  readTool,
  runAgent,
  toolSpecs,
} from '../src/index.js'
import type { AgentTool, ToolContext } from '../src/index.js'

const corpus = defineCorpus({
  id: 'test-planer',
  schemaVersion: 1,
  collections: {
    task: {
      fields: {
        title: f.text(),
        // Заметка не должна уезжать чужому провайдеру
        note: { ...f.text({ long: true }), redact: true },
        bucket: f.enum(['home', 'work']),
        done: f.bool(),
      },
      groupBy: 'bucket',
      label: (t) => t.title,
    },
  },
})

type Cols = (typeof corpus)['collections']

function makeDoc(): ReturnType<typeof createDocCore<Cols>> {
  const core = createDocCore<Cols>({ def: corpus, docId: 'DOC', actor: actorId() })
  core.tx((t) => {
    t.col.task.create({ title: 'Купить коробки', bucket: 'home', note: 'секрет' })
    t.col.task.create({ title: 'Отчёт', bucket: 'work', note: 'тоже секрет' })
  })
  return core
}

function slice(core: ReturnType<typeof createDocCore<Cols>>) {
  return createDocReadonly(corpus, core._state.value, {
    container: { collection: 'task', field: 'bucket', value: 'home' },
  })
}

describe('срез документа', () => {
  it('отдаёт текущий контейнер целиком, соседей — заголовками', () => {
    const doc = slice(makeDoc())
    expect(doc.task.count()).toBe(1)
    expect(doc.task.all()[0]?.title).toBe('Купить коробки')
    expect(doc.task.titles().map((t) => t.label)).toEqual(['Отчёт'])
  })

  it('вырезает поля с redact', () => {
    const doc = slice(makeDoc())
    const rec = doc.task.all()[0]
    expect(rec).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(rec as object, 'note')).toBe(false)
    expect(JSON.stringify(doc.task.all())).not.toContain('секрет')
  })

  it('весь документ — только по явному согласию', () => {
    const core = makeDoc()
    const whole = createDocReadonly(corpus, core._state.value, {
      container: { collection: 'task', field: 'bucket', value: 'home' },
      whole: true,
    })
    expect(whole.task.count()).toBe(2)
    expect(whole.task.titles()).toHaveLength(0)
  })

  it('служебные коллекции агенту не видны', () => {
    const core = makeDoc()
    const doc = createDocReadonly(corpus, core._state.value)
    expect(Object.keys(doc)).not.toContain('_proposals')
    expect(Object.keys(doc)).not.toContain('_actors')
  })

  it('у коллекции среза нет ни одного записывающего метода', () => {
    const doc = slice(makeDoc())
    const keys = Object.keys(doc.task)
    for (const forbidden of ['create', 'update', 'remove', 'restore', 'move', 'tx', 'commit', 'apply']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('контекст инструмента', () => {
  it('не содержит мутирующего API', () => {
    const core = makeDoc()
    const ctx: ToolContext<Cols> = {
      doc: slice(core),
      now: () => new Date(0),
      signal: new AbortController().signal,
    }
    expect(Object.keys(ctx).sort()).toEqual(['doc', 'now', 'signal'])
    const holder = ctx as unknown as Record<string, unknown>
    for (const forbidden of ['tx', 'create', 'update', 'remove', 'commit', 'actor', 'core', 'repo']) {
      expect(holder[forbidden]).toBeUndefined()
    }
  })
})

function toolsFor(seen: { input: unknown }): AgentTool<Cols>[] {
  const list = readTool<Cols, { bucket?: string }, unknown>({
    name: 'list_tasks',
    description: 'Задачи с фильтром',
    input: { type: 'object', properties: { bucket: { type: 'string' } } },
    parse: (raw) => (typeof raw === 'object' && raw !== null ? (raw as { bucket?: string }) : {}),
    run: (input, ctx) => {
      seen.input = input
      return Promise.resolve(ctx.doc.task.all().slice(0, 100))
    },
  })
  const propose = proposeTool<Cols, { items?: string[] }>({
    name: 'propose_tasks',
    description: 'Предложить новые задачи',
    input: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
    parse: (raw) => (typeof raw === 'object' && raw !== null ? (raw as { items?: string[] }) : {}),
    plan: (input) =>
      Promise.resolve(
        draft({
          title: 'Разбить переезд на задачи',
          changes: (input.items ?? []).map((title) => {
            const id: RecordId = recordId()
            const ops: Op[] = [
              { i: '000000000001-0000-aaaaaaaa', k: 's', c: 'task', r: id, v: { title } },
            ]
            return { kind: 'create' as const, collection: 'task', recordId: id, label: title, after: { title }, ops }
          }),
        }),
      ),
  })
  return [list, propose]
}

describe('прогон агента', () => {
  it('объявляет инструменты моделью только именем, описанием и схемой', () => {
    const specs = toolSpecs(toolsFor({ input: null }))
    expect(specs.map((s) => s.name)).toEqual(['list_tasks', 'propose_tasks'])
    for (const s of specs) expect(Object.keys(s).sort()).toEqual(['description', 'input', 'name'])
  })

  it('возвращает черновик и НЕ трогает документ', async () => {
    const core = makeDoc()
    const before = core.stateHash()
    const seen = { input: null as unknown }
    const result = await collectDrafts<Cols>({
      provider: createEchoProvider(),
      model: 'echo-1',
      tools: toolsFor(seen),
      doc: slice(core),
      request: 'разложи переезд, инструмент propose_tasks: {"items":["Коробки","Опись"]}',
      actor: core.actor,
      runId: 'run-1',
    })
    expect(result.error).toBeNull()
    expect(result.drafts).toHaveLength(1)
    const only: ProposalDraft | undefined = result.drafts[0]?.draft
    expect(only?.changes.map((c) => c.label)).toEqual(['Коробки', 'Опись'])
    expect(result.drafts[0]?.origin).toMatchObject({ provider: 'echo', model: 'echo-1', runId: 'run-1', toolName: 'propose_tasks' })
    // главное: состояние документа не изменилось ни на бит
    expect(core.stateHash()).toBe(before)
    expect(core.col.task.count.value).toBe(2)
  })

  it('останавливается по сигналу отмены', async () => {
    const core = makeDoc()
    const ctl = new AbortController()
    ctl.abort()
    const events = []
    for await (const ev of runAgent<Cols>({
      provider: createEchoProvider(),
      model: 'echo-1',
      tools: toolsFor({ input: null }),
      doc: slice(core),
      request: 'что угодно',
      actor: core.actor,
      signal: ctl.signal,
    })) {
      events.push(ev)
    }
    expect(events).toEqual([{ type: 'done', reason: 'abort', drafts: 0 }])
  })
})
