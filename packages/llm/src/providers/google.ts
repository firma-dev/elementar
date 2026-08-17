/** Gemini: `streamGenerateContent` (§10.3). Релей элементара его не проксирует — только direct или свой релей. */
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

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com'
export const GOOGLE_API_VERSION = 'v1beta'

export const GOOGLE_CAPABILITIES: LlmCapabilities = {
  streaming: true,
  tools: true,
  images: true,
  json: true,
  maxContext: 1_000_000,
}

interface GPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: unknown }
  functionResponse?: { name: string; response: { result: string } }
}

interface GContent {
  role: 'user' | 'model'
  parts: GPart[]
}

export interface GoogleBody {
  contents: GContent[]
  systemInstruction?: { parts: GPart[] }
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'NONE' | 'ANY'; allowedFunctionNames?: string[] } }
  generationConfig?: { maxOutputTokens?: number; temperature?: number; responseMimeType?: string }
}

function contentOf(m: LlmMessage): GContent {
  if (m.role === 'tool') {
    return {
      role: 'user',
      parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }],
    }
  }
  const parts: GPart[] = []
  for (const p of m.content) {
    if (p.type === 'text') parts.push({ text: p.text })
    else if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mime, data: p.dataB64 } })
    else parts.push({ functionCall: { name: p.name, args: p.input ?? {} } })
  }
  return { role: m.role === 'assistant' ? 'model' : 'user', parts }
}

export function toGoogleBody(req: LlmRequest): GoogleBody {
  const contents: GContent[] = []
  for (const m of req.messages) {
    const c = contentOf(m)
    if (c.parts.length === 0) continue
    const last = contents[contents.length - 1]
    if (last !== undefined && last.role === c.role) last.parts.push(...c.parts)
    else contents.push(c)
  }
  const body: GoogleBody = { contents }
  if (req.system !== undefined && req.system !== '') body.systemInstruction = { parts: [{ text: req.system }] }
  const generationConfig: { maxOutputTokens?: number; temperature?: number; responseMimeType?: string } = {}
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.responseFormat === 'json') generationConfig.responseMimeType = 'application/json'
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input,
        })),
      },
    ]
    if (req.toolChoice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    else if (typeof req.toolChoice === 'object')
      body.toolConfig = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [req.toolChoice.name] },
      }
  }
  return body
}

function stopReasonOf(raw: string | undefined): LlmStopReason | null {
  switch (raw) {
    case 'STOP':
      return 'end'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
      return 'refusal'
    default:
      return null
  }
}

export function createGoogleProvider(config: ProviderConfig, deps: ProviderDeps = {}): LlmProvider {
  const baseUrl = config.baseUrl ?? GOOGLE_BASE_URL
  const headers = (accept: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept,
    'x-goog-api-key': config.apiKey,
  })

  async function* stream(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    let res: Response
    try {
      if (config.apiKey === '') throw new LlmError('auth', 'ключ провайдера не задан')
      const path = `/${GOOGLE_API_VERSION}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`
      const endpoint = resolveEndpoint({
        providerId: config.providerId,
        baseUrl,
        path,
        transport: config.transport,
      })
      res = await llmFetch({
        endpoint,
        headers: headers('text/event-stream'),
        body: JSON.stringify(toGoogleBody(req)),
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
    let started = false
    let stop: LlmStopReason | null = null
    let calls = 0
    try {
      for await (const ev of readSse(res.body, signal)) {
        const data = jsonOf(ev.data)
        if (data === null) continue
        const err = obj(data, 'error')
        if (err !== undefined) {
          yield { type: 'error', code: 'server', message: str(err, 'message') ?? 'ошибка провайдера' }
          return
        }
        if (!started) {
          started = true
          yield { type: 'start', model: str(data, 'modelVersion') ?? req.model }
        }
        for (const rawCandidate of arr(data, 'candidates') ?? []) {
          const candidate = asObj(rawCandidate)
          if (candidate === undefined) continue
          for (const rawPart of arr(obj(candidate, 'content') ?? {}, 'parts') ?? []) {
            const part = asObj(rawPart)
            if (part === undefined) continue
            const text = str(part, 'text')
            if (text !== undefined && text !== '') yield { type: 'text', delta: text }
            const call = obj(part, 'functionCall')
            if (call !== undefined) {
              const name = str(call, 'name') ?? ''
              calls += 1
              // Gemini не выдаёт идентификатор вызова — синтезируем стабильный
              yield { type: 'tool_call', id: `${name}_${calls}`, name, input: call['args'] ?? {} }
            }
          }
          const finish = stopReasonOf(str(candidate, 'finishReason'))
          if (finish !== null) stop = finish
        }
        const usage = obj(data, 'usageMetadata')
        if (usage !== undefined) {
          yield {
            type: 'usage',
            input: num(usage, 'promptTokenCount') ?? 0,
            output: num(usage, 'candidatesTokenCount') ?? 0,
          }
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
    if (signal?.aborted === true) yield { type: 'stop', reason: 'abort' }
    else yield { type: 'stop', reason: stop ?? (calls > 0 ? 'tool_use' : 'end') }
  }

  async function listModels(): Promise<ModelInfo[]> {
    const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))
    const url = `${baseUrl.replace(/\/$/, '')}/${GOOGLE_API_VERSION}/models`
    const res = await doFetch(url, {
      method: 'GET',
      headers: headers('application/json'),
      credentials: 'omit',
    })
    if (!res.ok) throw new LlmError(res.status === 401 || res.status === 403 ? 'auth' : 'server', `HTTP ${res.status}`)
    const body = asObj((await res.json()) as unknown)
    return (arr(body ?? {}, 'models') ?? []).flatMap((raw) => {
      const o = asObj(raw)
      const name = str(o, 'name')
      if (name === undefined) return []
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name
      return [
        {
          id,
          label: str(o, 'displayName') ?? id,
          context: num(o, 'inputTokenLimit') ?? GOOGLE_CAPABILITIES.maxContext,
        },
      ]
    })
  }

  return {
    id: config.providerId,
    label: config.label ?? 'Google Gemini',
    capabilities: GOOGLE_CAPABILITIES,
    listModels,
    stream,
  }
}
