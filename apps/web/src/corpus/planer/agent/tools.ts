import { createChange, draft, proposeTool, readTool } from '@elementar/llm'
import type { AgentTool } from '@elementar/llm'
import { recordId } from '@elementar/core'
import type { HlcString, Op, RecordId } from '@elementar/core'
import { LISTS, listBucket } from '../schema.js'
import type { ListKey, PlanerCollections, Task } from '../schema.js'
import { S } from '../strings.js'

type Tools = AgentTool<PlanerCollections>

interface ListTasksInput {
  bucket?: string
  done?: boolean
  limit?: number
}

interface ProposeItem {
  title: string
  bucket?: string
  date?: string
  note?: string
}

interface ProposeInput {
  title?: string
  items: ProposeItem[]
}

const BUCKET_VALUES = [...LISTS.map((l: ListKey) => listBucket(l))]

function parseListTasks(raw: unknown): ListTasksInput | null {
  if (typeof raw !== 'object' || raw === null) return {}
  const o = raw as Record<string, unknown>
  const out: ListTasksInput = {}
  if (typeof o['bucket'] === 'string') out.bucket = o['bucket']
  if (typeof o['done'] === 'boolean') out.done = o['done']
  if (typeof o['limit'] === 'number') out.limit = o['limit']
  return out
}

function parsePropose(raw: unknown): ProposeInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const rawItems = o['items']
  if (!Array.isArray(rawItems)) return null
  const items: ProposeItem[] = []
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const title = e['title']
    if (typeof title !== 'string' || title.trim() === '') continue
    const item: ProposeItem = { title: title.trim().slice(0, 400) }
    if (typeof e['bucket'] === 'string') item.bucket = e['bucket']
    if (typeof e['date'] === 'string') item.date = e['date']
    if (typeof e['note'] === 'string') item.note = e['note']
    items.push(item)
  }
  if (items.length === 0) return null
  const out: ProposeInput = { items: items.slice(0, 20) }
  if (typeof o['title'] === 'string') out.title = o['title']
  return out
}

/** Операция создания задачи внутри предложения: применится только после подтверждения. */
function createOps(id: RecordId, item: ProposeItem, bucket: string): Op[] {
  const zero = '000000000000-0000-agent00' as HlcString
  return [
    {
      i: zero,
      k: 's',
      c: 'task',
      r: id,
      v: {
        title: item.title,
        note: item.note ?? '',
        bucket,
        done: false,
        doneAt: null,
        date: item.date ?? null,
        time: null,
      },
    },
  ]
}

export const PLANER_TOOLS: Tools[] = [
  readTool<PlanerCollections, ListTasksInput, unknown>({
    name: 'list_tasks',
    description: 'Задачи с фильтром: контейнер (list:work | list:home | list:hobby | list:craft | proj:<id>) и признак выполнения.',
    input: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: 'Контейнер задачи', enum: BUCKET_VALUES },
        done: { type: 'boolean', description: 'Только выполненные или только открытые' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    parse: parseListTasks,
    run: async (input, ctx) => {
      const limit = Math.min(100, Math.max(1, input.limit ?? 50))
      const where: Record<string, unknown> = {}
      if (input.bucket !== undefined) where['bucket'] = input.bucket
      if (input.done !== undefined) where['done'] = input.done
      return ctx.doc.task.where(where as never).slice(0, limit)
    },
  }),

  readTool<PlanerCollections, Record<string, never>, unknown>({
    name: 'list_projects',
    description: 'Проекты планера: id, название, срок, архив.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    parse: () => ({}) as Record<string, never>,
    run: async (_input, ctx) => ctx.doc.project.all().slice(0, 50),
  }),

  proposeTool<PlanerCollections, ProposeInput>({
    name: 'propose_tasks',
    description: 'Предложить новые задачи. Ничего не создаёт: человек подтверждает предложение целиком или по строкам.',
    input: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Заголовок предложения' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              note: { type: 'string' },
              bucket: { type: 'string', enum: BUCKET_VALUES },
              date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    parse: parsePropose,
    plan: async (input) =>
      draft({
        title: input.title ?? S.agent.proposed,
        changes: input.items.map((item) => {
          const bucket = item.bucket ?? listBucket('work')
          const id = recordId()
          return createChange({
            collection: 'task',
            recordId: id,
            label: item.title,
            after: { title: item.title, bucket, date: item.date ?? null } as Partial<Task>,
            ops: createOps(id, item, bucket),
          })
        }),
      }),
  }),
]
