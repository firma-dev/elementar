/** Claude: SSE `/v1/messages` (§10.3). */
import { LlmError, errorEvent, isAbort } from '../errors.js'
import { asObj, jsonOf, num, obj, readSse, str } from '../sse.js'
import { llmFetch, resolveEndpoint } from '../transport.js'
import type {
  LlmCapabilities,
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  ProviderConfig,
} from '../types.js'
import type { ProviderDeps } from './deps.js'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_PATH = '/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 2048

export const ANTHROPIC_CAPABILITIES: LlmCapabilities = {
  streaming: true,
  tools: true,
  images: true,
  json: true,
  maxContext: 200_000,
}

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  source?: { type: 'base64'; media_type: string; data: string }
  tool_use_id?: string
  content?: string
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export interface AnthropicBody {
  model: string
  max_tokens: number
  stream: true
  messages: AnthropicMessage[]
  system?: string
  temperature?: number
  tools?: Array<{ name: string; description: string; input_schema: unknown }>
  tool_choice?: { type: 'auto' | 'none' | 'tool'; name?: string }
}

function blocksOf(m: LlmMessage): { role: 'user' | 'assistant'; blocks: AnthropicBlock[] } {
  if (m.role === 'tool') {
    return {
      role: 'user',
      blocks: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
    }
  }
  const blocks: AnthropicBlock[] = []
  for (const p of m.content) {
    if (p.type === 'text') blocks.push({ type: 'text', text: p.text })
    else if (p.type === 'image')
      blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.dataB64 } })
    else blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} })
  }
  return { role: m.role, blocks }
}

export function toAnthropicBody(req: LlmRequest): AnthropicBody {
  const messages: AnthropicMessage[] = []
  for (const m of req.messages) {
    const { role, blocks } = blocksOf(m)
    if (blocks.length === 0) continue
    const last = messages[messages.length - 1]
    // Anthropic требует чередования ролей: подряд идущие tool_result сливаем в одно сообщение
    if (last !== undefined && last.role === role) last.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }
  const body: AnthropicBody = {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: true,
    messages,
  }
  const jsonHint = req.responseFormat === 'json' ? 'Ответ — один JSON-объект, без пояснений.' : ''
  const system = [req.system ?? '', jsonHint].filter((s) => s !== '').join('\n\n')
  if (system !== '') body.system = system
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input,
    }))
    if (req.toolChoice === 'none') body.tool_choice = { type: 'none' }
    else if (req.toolChoice === 'auto') body.tool_choice = { type: 'auto' }
    else if (typeof req.toolChoice === 'object') body.tool_choice = { type: 'tool', name: req.toolChoice.name }
  }
  return body
}

function stopReasonOf(raw: string | undefined): LlmStopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'refusal'
    default:
      return 'end'
  }
}

interface ToolAcc {
  id: string
  name: string
  json: string
}

/** Разбор потока событий Anthropic. Состояние — открытые блоки по индексу. */
export function createAnthropicDecoder(): (event: string, data: Record<string, unknown>) => LlmEvent[] {
  const tools = new Map<number, ToolAcc>()
  let stop: LlmStopReason | null = null
  return (event, data) => {
    const out: LlmEvent[] = []
    if (event === 'message_start') {
      const msg = obj(data, 'message')
      const model = str(msg, 'model')
      if (model !== undefined) out.push({ type: 'start', model })
      const usage = obj(msg, 'usage')
      const input = num(usage, 'input_tokens')
      if (input !== undefined) out.push({ type: 'usage', input, output: num(usage, 'output_tokens') ?? 0 })
      return out
    }
    if (event === 'content_block_start') {
      const index = num(data, 'index') ?? 0
      const block = obj(data, 'content_block')
      if (str(block, 'type') === 'tool_use') {
        tools.set(index, { id: str(block, 'id') ?? '', name: str(block, 'name') ?? '', json: '' })
      }
      return out
    }
    if (event === 'content_block_delta') {
      const index = num(data, 'index') ?? 0
      const delta = obj(data, 'delta')
      const kind = str(delta, 'type')
      if (kind === 'text_delta') {
        const text = str(delta, 'text')
        if (text !== undefined && text !== '') out.push({ type: 'text', delta: text })
      } else if (kind === 'thinking_delta') {
        const text = str(delta, 'thinking')
        if (text !== undefined && text !== '') out.push({ type: 'thinking', delta: text })
      } else if (kind === 'input_json_delta') {
        const acc = tools.get(index)
        if (acc !== undefined) acc.json += str(delta, 'partial_json') ?? ''
      }
      return out
    }
    if (event === 'content_block_stop') {
      const index = num(data, 'index') ?? 0
      const acc = tools.get(index)
      if (acc !== undefined) {
        tools.delete(index)
        out.push({ type: 'tool_call', id: acc.id, name: acc.name, input: parseToolInput(acc.json) })
      }
      return out
    }
    if (event === 'message_delta') {
      const delta = obj(data, 'delta')
      stop = stopReasonOf(str(delta, 'stop_reason'))
      const usage = obj(data, 'usage')
      const output = num(usage, 'output_tokens')
      if (output !== undefined) out.push({ type: 'usage', input: num(usage, 'input_tokens') ?? 0, output })
      return out
    }
    if (event === 'message_stop') {
      out.push({ type: 'stop', reason: stop ?? 'end' })
      return out
    }
    if (event === 'error') {
      const err = obj(data, 'error')
      const message = str(err, 'message') ?? 'ошибка провайдера'
      const kind = str(err, 'type') ?? ''
      const code = kind.includes('rate') ? 'rate' : kind.includes('overloaded') ? 'server' : 'server'
      out.push({ type: 'error', code, message })
      return out
    }
    return out
  }
}

function parseToolInput(json: string): unknown {
  if (json.trim() === '') return {}
  try {
    return JSON.parse(json) as unknown
  } catch {
    return {}
  }
}

interface ModelsPage {
  data?: unknown[]
}

export function createAnthropicProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
): LlmProvider {
  const baseUrl = config.baseUrl ?? ANTHROPIC_BASE_URL
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
    // Разрешение на прямой вызов из браузера — только в direct-режиме (§10.1)
    if (config.transport.mode === 'direct') h['anthropic-dangerous-direct-browser-access'] = 'true'
    return h
  }

  async function* stream(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    let res: Response
    try {
      if (config.apiKey === '') throw new LlmError('auth', 'ключ провайдера не задан')
      const endpoint = resolveEndpoint({
        providerId: 'anthropic',
        baseUrl,
        path: ANTHROPIC_PATH,
        transport: config.transport,
      })
      res = await llmFetch({
        endpoint,
        headers: headers(),
        body: JSON.stringify(toAnthropicBody(req)),
        fetch: deps.fetch,
        signal,
        challenge: deps.challenge?.() ?? null,
      })
    } catch (e) {
      if (isAbort(e)) {
        yield { type: 'stop', reason: 'abort' }
        return
      }
      yield errorEvent(e)
      return
    }
    const decode = createAnthropicDecoder()
    let stopped = false
    try {
      for await (const ev of readSse(res.body, signal)) {
        const data = jsonOf(ev.data)
        if (data === null) continue
        const type = str(data, 'type') ?? ev.event
        for (const out of decode(type, data)) {
          if (out.type === 'stop') stopped = true
          yield out
        }
      }
    } catch (e) {
      if (isAbort(e) || signal?.aborted === true) {
        yield { type: 'stop', reason: 'abort' }
        return
      }
      yield errorEvent(e)
      return
    }
    if (!stopped) yield { type: 'stop', reason: signal?.aborted === true ? 'abort' : 'end' }
  }

  async function listModels(): Promise<Array<{ id: string; label: string; context: number }>> {
    const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))
    const url = `${baseUrl.replace(/\/$/, '')}/v1/models`
    const res = await doFetch(url, { method: 'GET', headers: headers(), credentials: 'omit' })
    if (!res.ok) throw new LlmError(res.status === 401 ? 'auth' : 'server', `HTTP ${res.status}`)
    const body = (await res.json()) as ModelsPage
    const list = Array.isArray(body.data) ? body.data : []
    return list.flatMap((raw) => {
      const o = asObj(raw)
      const id = str(o, 'id')
      if (id === undefined) return []
      return [{ id, label: str(o, 'display_name') ?? id, context: ANTHROPIC_CAPABILITIES.maxContext }]
    })
  }

  return {
    id: config.providerId,
    label: config.label ?? 'Anthropic',
    capabilities: ANTHROPIC_CAPABILITIES,
    listModels,
    stream,
  }
}
