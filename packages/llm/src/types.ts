/**
 * Слот под модель (§10.3). Единый интерфейс провайдера: стриминг и вызов инструментов.
 * Пакет целиком — ленивый чанк: он не грузится, пока человек не открыл слот модели
 * или не нажал кнопку агента.
 */
import type { ReadonlySignal } from '@preact/signals-core'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Подмножество JSON Schema, которое понимают все три семейства API. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  items?: JsonSchema
  enum?: readonly (string | number | boolean | null)[]
  additionalProperties?: boolean | JsonSchema
  format?: string
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export interface LlmCapabilities {
  streaming: boolean
  tools: boolean
  images: boolean
  json: boolean
  maxContext: number
}

export interface ModelInfo {
  id: string
  label: string
  context: number
}

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataB64: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }

export type LlmMessage =
  | { role: 'user' | 'assistant'; content: LlmPart[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface LlmToolSpec {
  name: string
  description: string
  input: JsonSchema
}

export interface LlmRequest {
  model: string
  system?: string
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  toolChoice?: 'auto' | 'none' | { name: string }
  maxTokens?: number
  temperature?: number
  responseFormat?: 'text' | 'json'
}

export type LlmErrorCode =
  | 'auth'
  | 'rate'
  | 'context'
  | 'network'
  | 'cors'
  | 'model'
  | 'server'
  | 'aborted'

export type LlmStopReason = 'end' | 'tool_use' | 'length' | 'abort' | 'refusal'

export type LlmEvent =
  | { type: 'start'; model: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'stop'; reason: LlmStopReason }
  | { type: 'error'; code: LlmErrorCode; message: string; retryAfterMs?: number }

export interface LlmProvider {
  readonly id: string
  readonly label: string
  readonly capabilities: LlmCapabilities
  listModels?(): Promise<ModelInfo[]>
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
}

/**
 * Транспорт (§10.1). Авто-фолбэк на 'elm-relay' запрещён: переключение только
 * по явному действию человека и запоминается пер-провайдер.
 */
export interface LlmTransportConfig {
  mode: 'direct' | 'own-relay' | 'elm-relay'
  relayUrl?: string
}

export interface ProviderConfig {
  providerId: string
  baseUrl?: string
  apiKey: string
  model: string
  label?: string
  transport: LlmTransportConfig
}

export type ProbeResult = { ok: true; models: ModelInfo[] } | { ok: false; code: LlmErrorCode }

export interface LlmRegistry {
  configs: ReadonlySignal<readonly ProviderConfig[]>
  active: ReadonlySignal<ProviderConfig | null>
  add(c: ProviderConfig): Promise<void>
  remove(id: string): Promise<void>
  setActive(id: string): Promise<void>
  probe(c: ProviderConfig): Promise<ProbeResult>
  resolve(): LlmProvider | null
}

export function isLlmErrorCode(v: unknown): v is LlmErrorCode {
  return (
    v === 'auth' ||
    v === 'rate' ||
    v === 'context' ||
    v === 'network' ||
    v === 'cors' ||
    v === 'model' ||
    v === 'server' ||
    v === 'aborted'
  )
}

/** Последний текстовый кусок сообщения — нужен адаптерам и заглушке. */
export function lastUserText(messages: readonly LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'user') continue
    return m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

export function textOfParts(parts: readonly LlmPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
