/**
 * OpenAI-совместимый адаптер: OpenAI, DeepSeek, Qwen, GLM, Mistral, OpenRouter,
 * Ollama/LM Studio на localhost — один адаптер, различие в `baseUrl` и `model` (§10.3).
 */
import { LlmError, errorEvent, isAbort } from '../errors.js'
import { arr, asObj, jsonOf, num, obj, readSse, str } from '../sse.js'
import { llmFetch, resolveEndpoint } from '../transport.js'
import type {
  LlmCapabilities,
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  ModelInfo,
  ProviderConfig,
} from '../types.js'
import type { ProviderDeps } from './deps.js'

export const OPENAI_BASE_URL = 'https://api.openai.com'
export const OPENAI_CHAT_PATH = '/v1/chat/completions'
export const OPENAI_MODELS_PATH = '/v1/models'

export const OPENAI_CAPABILITIES: LlmCapabilities = {
  streaming: true,
  tools: true,
  images: true,
  json: true,
  maxContext: 128_000,
}

export interface OpenAiOptions {
  /** Путь чата: у DeepSeek он без префикса /v1. */
  chatPath?: string
  modelsPath?: string
  /** Ollama и часть совместимых не понимают stream_options. */
  usageOption?: boolean
  capabilities?: LlmCapabilities
  /** Заголовок ключа: у всех совместимых это Bearer. */
  extraHeaders?: Record<string, string>
}

interface OaiTextPart {
  type: 'text'
  text: string
}
interface OaiImagePart {
  type: 'image_url'
  image_url: { url: string }
}
type OaiPart = OaiTextPart | OaiImagePart

interface OaiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OaiPart[] | null
  tool_calls?: OaiToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAiBody {
  model: string
  messages: OaiMessage[]
  stream: true
  stream_options?: { include_usage: true }
  max_tokens?: number
  temperature?: number
  response_format?: { type: 'json_object' }
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
}

function messageOf(m: LlmMessage): OaiMessage[] {
  if (m.role === 'tool') {
    return [{ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content }]
  }
  const parts: OaiPart[] = []
  const calls: OaiToolCall[] = []
  for (const p of m.content) {
    if (p.type === 'text') parts.push({ type: 'text', text: p.text })
    else if (p.type === 'image')
      parts.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.dataB64}` } })
    else
      calls.push({
        id: p.id,
        type: 'function',
        function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
      })
  }
  const onlyText = parts.every((p) => p.type === 'text')
  const content = parts.length === 0 ? null : onlyText ? parts.map((p) => (p as OaiTextPart).text).join('') : parts
  const out: OaiMessage = { role: m.role, content }
  if (calls.length > 0) out.tool_calls = calls
  return [out]
}

export function toOpenAiBody(req: LlmRequest, opts: OpenAiOptions = {}): OpenAiBody {
  const messages: OaiMessage[] = []
  if (req.system !== undefined && req.system !== '') messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) messages.push(...messageOf(m))
  const body: OpenAiBody = { model: req.model, messages, stream: true }
  if (opts.usageOption !== false) body.stream_options = { include_usage: true }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.responseFormat === 'json') body.response_format = { type: 'json_object' }
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input },
    }))
    if (req.toolChoice === 'none' || req.toolChoice === 'auto') body.tool_choice = req.toolChoice
    else if (typeof req.toolChoice === 'object')
      body.tool_choice = { type: 'function', function: { name: req.toolChoice.name } }
  }
  return body
}

function stopReasonOf(raw: string | undefined): LlmStopReason | null {
  switch (raw) {
    case 'stop':
      return 'end'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'refusal'
    default:
      return null
  }
}

interface CallAcc {
  id: string
  name: string
  args: string
}

export interface OpenAiDecoder {
  push(chunk: Record<string, unknown>): LlmEvent[]
  /** Хвост: часть серверов обрывает поток без finish_reason. */
  finish(): LlmEvent[]
}

/** Разбор чанков chat.completions: tool_calls приходят кусками по индексу. */
export function createOpenAiDecoder(): OpenAiDecoder {
  const calls = new Map<number, CallAcc>()
  let started = false
  let stop: LlmStopReason | null = null
  let flushed = false
  const flushCalls = (): LlmEvent[] => {
    if (flushed) return []
    flushed = true
    const out: LlmEvent[] = []
    for (const index of [...calls.keys()].sort((a, b) => a - b)) {
      const acc = calls.get(index)
      if (acc === undefined || acc.name === '') continue
      out.push({ type: 'tool_call', id: acc.id === '' ? `call_${index}` : acc.id, name: acc.name, input: parseArgs(acc.args) })
    }
    return out
  }
  const push = (chunk: Record<string, unknown>): LlmEvent[] => {
    const out: LlmEvent[] = []
    const model = str(chunk, 'model')
    if (!started && model !== undefined) {
      started = true
      out.push({ type: 'start', model })
    }
    const usage = obj(chunk, 'usage')
    if (usage !== undefined) {
      out.push({
        type: 'usage',
        input: num(usage, 'prompt_tokens') ?? 0,
        output: num(usage, 'completion_tokens') ?? 0,
      })
    }
    const choices = arr(chunk, 'choices') ?? []
    for (const rawChoice of choices) {
      const choice = asObj(rawChoice)
      if (choice === undefined) continue
      const delta = obj(choice, 'delta') ?? obj(choice, 'message')
      const content = str(delta, 'content')
      if (content !== undefined && content !== '') out.push({ type: 'text', delta: content })
      // DeepSeek-reasoner и совместимые отдают размышления отдельным полем
      const reasoning = str(delta, 'reasoning_content') ?? str(delta, 'reasoning')
      if (reasoning !== undefined && reasoning !== '') out.push({ type: 'thinking', delta: reasoning })
      for (const rawCall of arr(delta ?? {}, 'tool_calls') ?? []) {
        const call = asObj(rawCall)
        if (call === undefined) continue
        const index = num(call, 'index') ?? 0
        const acc = calls.get(index) ?? { id: '', name: '', args: '' }
        const id = str(call, 'id')
        if (id !== undefined) acc.id = id
        const fn = obj(call, 'function')
        const name = str(fn, 'name')
        if (name !== undefined) acc.name = name
        acc.args += str(fn, 'arguments') ?? ''
        calls.set(index, acc)
      }
      const finish = stopReasonOf(str(choice, 'finish_reason'))
      if (finish !== null) {
        stop = finish
        out.push(...flushCalls())
      }
    }
    if (stop !== null) {
      const reason = stop
      stop = null
      out.push({ type: 'stop', reason })
    }
    return out
  }
  return { push, finish: flushCalls }
}

function parseArgs(args: string): unknown {
  if (args.trim() === '') return {}
  try {
    return JSON.parse(args) as unknown
  } catch {
    return {}
  }
}

export function createOpenAiProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
  opts: OpenAiOptions = {},
): LlmProvider {
  const baseUrl = config.baseUrl ?? OPENAI_BASE_URL
  const chatPath = opts.chatPath ?? OPENAI_CHAT_PATH
  const capabilities = opts.capabilities ?? OPENAI_CAPABILITIES
  const headers = (accept: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept,
    // Локальные движки (Ollama/LM Studio) ключа не требуют — заголовок всё равно безвреден
    authorization: `Bearer ${config.apiKey}`,
    ...(opts.extraHeaders ?? {}),
  })

  async function* stream(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    let res: Response
    try {
      const endpoint = resolveEndpoint({
        providerId: config.providerId,
        baseUrl,
        path: chatPath,
        transport: config.transport,
      })
      res = await llmFetch({
        endpoint,
        headers: headers('text/event-stream'),
        body: JSON.stringify(toOpenAiBody(req, opts)),
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
    const decode = createOpenAiDecoder()
    let stopped = false
    try {
      for await (const ev of readSse(res.body, signal)) {
        const data = jsonOf(ev.data)
        if (data === null) continue
        const err = obj(data, 'error')
        if (err !== undefined) {
          yield { type: 'error', code: 'server', message: str(err, 'message') ?? 'ошибка провайдера' }
          return
        }
        for (const out of decode.push(data)) {
          if (out.type === 'stop') stopped = true
          yield out
        }
      }
      if (!stopped) for (const out of decode.finish()) yield out
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

  async function listModels(): Promise<ModelInfo[]> {
    const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))
    const url = `${baseUrl.replace(/\/$/, '')}${opts.modelsPath ?? OPENAI_MODELS_PATH}`
    const res = await doFetch(url, {
      method: 'GET',
      headers: headers('application/json'),
      credentials: 'omit',
    })
    if (!res.ok) throw new LlmError(res.status === 401 ? 'auth' : 'server', `HTTP ${res.status}`)
    const body = asObj((await res.json()) as unknown)
    const list = arr(body ?? {}, 'data') ?? arr(body ?? {}, 'models') ?? []
    return list.flatMap((raw) => {
      const o = asObj(raw)
      const id = str(o, 'id') ?? str(o, 'name')
      if (id === undefined) return []
      return [{ id, label: id, context: capabilities.maxContext }]
    })
  }

  return {
    id: config.providerId,
    label: config.label ?? 'OpenAI-совместимый',
    capabilities,
    listModels,
    stream,
  }
}
