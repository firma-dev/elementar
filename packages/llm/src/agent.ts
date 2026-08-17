/**
 * Прогон агента (§10.4). Единственный результат прогона — черновики предложений.
 * Записать их в документ может только человек: `runAgent` не имеет доступа
 * ни к транзакциям ядра, ни к ProposalStore — он их даже не импортирует.
 */
import { randomBase62 } from '@elementar/core'
import type { ActorId, CollectionsDef, ProposalDraft, ProposalOrigin } from '@elementar/core'
import { errorOf } from './errors.js'
import type { DocReadonly } from './slice.js'
import { findTool, isProposeTool, parseToolInput, toolSpecs } from './tools.js'
import type { AgentTool, ToolContext } from './tools.js'
import type { LlmErrorCode, LlmMessage, LlmPart, LlmProvider, LlmRequest, LlmStopReason } from './types.js'

export const AGENT_MAX_TURNS = 4
export const TOOL_RESULT_MAX_CHARS = 16_384

export const AGENT_SYSTEM_PROMPT = [
  'Ты помощник внутри личного планера. Ты ничего не меняешь сам:',
  'любое изменение оформляется инструментом с эффектом propose и попадает человеку',
  'на подтверждение. Не выдумывай записи, которых нет в срезе документа.',
  'Отвечай по-русски, коротко. Формулировки задач — в повелительном наклонении.',
].join(' ')

export type AgentDoneReason = 'end' | 'length' | 'abort' | 'refusal' | 'max-turns'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; effect: 'read' | 'propose' }
  | { type: 'tool-result'; name: string; ok: boolean }
  | { type: 'draft'; draft: ProposalDraft; origin: ProposalOrigin }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; code: LlmErrorCode; message: string }
  | { type: 'done'; reason: AgentDoneReason; drafts: number }

export interface AgentRunOptions<S extends CollectionsDef> {
  provider: LlmProvider
  model: string
  tools: readonly AgentTool<S>[]
  doc: DocReadonly<S>
  /** Что человек написал в шите «Что нужно сделать?». */
  request: string
  system?: string
  actor: ActorId
  runId?: string
  maxTurns?: number
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  now?(): number
}

function clip(s: string): string {
  return s.length <= TOOL_RESULT_MAX_CHARS ? s : `${s.slice(0, TOOL_RESULT_MAX_CHARS)}…`
}

function jsonOfResult(v: unknown): string {
  try {
    return clip(JSON.stringify(v ?? null) ?? 'null')
  } catch {
    return '{"error":"результат инструмента не сериализуется"}'
  }
}

function doneReason(stop: LlmStopReason | null): AgentDoneReason {
  if (stop === 'length') return 'length'
  if (stop === 'abort') return 'abort'
  if (stop === 'refusal') return 'refusal'
  return 'end'
}

/**
 * Один прогон. Поток событий для UI: текст модели, вызовы инструментов и черновики.
 * Возвращаемые черновики никуда не записаны — их принимает человек.
 */
export async function* runAgent<S extends CollectionsDef>(
  o: AgentRunOptions<S>,
): AsyncGenerator<AgentEvent> {
  const nowFn = o.now ?? Date.now
  const runId = o.runId ?? randomBase62(12)
  const controller = new AbortController()
  const signal = o.signal ?? controller.signal
  const ctx: ToolContext<S> = {
    doc: o.doc,
    now: () => new Date(nowFn()),
    signal,
  }
  const specs = toolSpecs(o.tools)
  const messages: LlmMessage[] = [
    { role: 'user', content: [{ type: 'text', text: o.request }] },
  ]
  const maxTurns = o.maxTurns ?? AGENT_MAX_TURNS
  let drafts = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) {
      yield { type: 'done', reason: 'abort', drafts }
      return
    }
    const req: LlmRequest = {
      model: o.model,
      system: o.system ?? AGENT_SYSTEM_PROMPT,
      messages,
      ...(specs.length > 0 ? { tools: specs, toolChoice: 'auto' as const } : {}),
      ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    }
    const calls: Array<{ id: string; name: string; input: unknown }> = []
    let text = ''
    let stop: LlmStopReason | null = null
    let failed = false

    for await (const ev of o.provider.stream(req, signal)) {
      switch (ev.type) {
        case 'start':
          break
        case 'text':
          text += ev.delta
          yield { type: 'text', delta: ev.delta }
          break
        case 'thinking':
          yield { type: 'thinking', delta: ev.delta }
          break
        case 'tool_call':
          calls.push({ id: ev.id, name: ev.name, input: ev.input })
          break
        case 'usage':
          yield { type: 'usage', input: ev.input, output: ev.output }
          break
        case 'error':
          failed = true
          yield { type: 'error', code: ev.code, message: ev.message }
          break
        case 'stop':
          stop = ev.reason
          break
      }
      if (failed) break
    }

    if (failed) {
      yield { type: 'done', reason: 'end', drafts }
      return
    }
    if (calls.length === 0) {
      yield { type: 'done', reason: doneReason(stop), drafts }
      return
    }

    const assistant: LlmPart[] = []
    if (text !== '') assistant.push({ type: 'text', text })
    for (const c of calls) assistant.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input })
    messages.push({ role: 'assistant', content: assistant })

    for (const call of calls) {
      const tool = findTool(o.tools, call.name)
      if (tool === undefined) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `{"error":"инструмент ${call.name} не объявлен"}`,
        })
        yield { type: 'tool-result', name: call.name, ok: false }
        continue
      }
      yield { type: 'tool', name: tool.name, effect: tool.effect }
      const input = parseToolInput(tool, call.input)
      if (input === null) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: '{"error":"аргументы не прошли проверку"}',
        })
        yield { type: 'tool-result', name: call.name, ok: false }
        continue
      }
      try {
        if (isProposeTool(tool)) {
          const planned = await tool.plan(input, ctx)
          drafts += 1
          const origin: ProposalOrigin = {
            provider: o.provider.id,
            model: o.model,
            runId,
            toolName: tool.name,
            by: o.actor,
          }
          yield { type: 'draft', draft: planned, origin }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: `{"proposed":${planned.changes.length},"awaiting":"человек подтверждает"}`,
          })
        } else {
          const result = await tool.run(input, ctx)
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: jsonOfResult(result),
          })
        }
        yield { type: 'tool-result', name: call.name, ok: true }
      } catch (e) {
        const err = errorOf(e, 'server')
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: err.message }),
        })
        yield { type: 'tool-result', name: call.name, ok: false }
      }
    }
  }

  yield { type: 'done', reason: 'max-turns', drafts }
}

export interface AgentRunResult {
  drafts: Array<{ draft: ProposalDraft; origin: ProposalOrigin }>
  text: string
  reason: AgentDoneReason
  error: { code: LlmErrorCode; message: string } | null
  usage: { input: number; output: number }
}

/** Удобная обёртка для случаев, когда поток не нужен, нужен итог. */
export async function collectDrafts<S extends CollectionsDef>(
  o: AgentRunOptions<S>,
): Promise<AgentRunResult> {
  const out: AgentRunResult = {
    drafts: [],
    text: '',
    reason: 'end',
    error: null,
    usage: { input: 0, output: 0 },
  }
  for await (const ev of runAgent(o)) {
    if (ev.type === 'text') out.text += ev.delta
    else if (ev.type === 'draft') out.drafts.push({ draft: ev.draft, origin: ev.origin })
    else if (ev.type === 'usage') {
      out.usage.input += ev.input
      out.usage.output += ev.output
    } else if (ev.type === 'error') out.error = { code: ev.code, message: ev.message }
    else if (ev.type === 'done') out.reason = ev.reason
  }
  return out
}
