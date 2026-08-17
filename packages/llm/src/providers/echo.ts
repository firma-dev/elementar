/**
 * Детерминированная заглушка для тестов и демо без ключа (§10.3).
 * Сети не касается. Полезное свойство: умеет пройти полный цикл вызова
 * инструмента — первый ход зовёт инструмент, второй отвечает текстом.
 */
import { lastUserText } from '../types.js'
import type { LlmCapabilities, LlmEvent, LlmProvider, LlmRequest, ProviderConfig } from '../types.js'

export const ECHO_PROVIDER_ID = 'echo'
export const ECHO_MODEL = 'echo-1'

export const ECHO_CAPABILITIES: LlmCapabilities = {
  streaming: true,
  tools: true,
  images: false,
  json: true,
  maxContext: 8192,
}

/** Слова ответа режутся детерминированно: три куска независимо от длины. */
export function echoChunks(text: string): string[] {
  if (text === '') return ['']
  const size = Math.ceil(text.length / 3)
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** Ввод инструмента берётся из первого JSON-объекта в тексте запроса. */
export function echoToolInput(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return {}
  }
}

function tokens(s: string): number {
  return Math.ceil(s.length / 4)
}

export function createEchoProvider(config?: Partial<ProviderConfig>): LlmProvider {
  const model = config?.model ?? ECHO_MODEL
  async function* stream(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    // Через вызов, а не через прямое чтение: иначе сужение типа схлопнет проверку в цикле
    const aborted = (): boolean => signal?.aborted === true
    yield { type: 'start', model: req.model === '' ? model : req.model }
    if (aborted()) {
      yield { type: 'stop', reason: 'abort' }
      return
    }
    const prompt = lastUserText(req.messages)
    const answered = req.messages.some((m) => m.role === 'tool')
    // Детерминированный выбор: инструмент, чьё имя названо в запросе, иначе первый
    const tool = req.tools?.find((t) => prompt.includes(t.name)) ?? req.tools?.[0]
    if (!answered && tool !== undefined && req.toolChoice !== 'none') {
      yield { type: 'tool_call', id: `echo_1`, name: tool.name, input: echoToolInput(prompt) }
      yield { type: 'usage', input: tokens(prompt), output: 1 }
      yield { type: 'stop', reason: 'tool_use' }
      return
    }
    const reply = `эхо: ${prompt}`
    for (const chunk of echoChunks(reply)) {
      if (aborted()) {
        yield { type: 'stop', reason: 'abort' }
        return
      }
      yield { type: 'text', delta: chunk }
    }
    yield { type: 'usage', input: tokens(prompt), output: tokens(reply) }
    yield { type: 'stop', reason: 'end' }
  }

  return {
    id: config?.providerId ?? ECHO_PROVIDER_ID,
    label: config?.label ?? 'Заглушка',
    capabilities: ECHO_CAPABILITIES,
    listModels: () => Promise.resolve([{ id: model, label: 'Заглушка', context: ECHO_CAPABILITIES.maxContext }]),
    stream,
  }
}
