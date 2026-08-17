/** Разбор text/event-stream: общий для всех трёх адаптеров. */

export interface SseEvent {
  event: string
  data: string
  id?: string
}

/**
 * Инкрементальный парсер. Держит хвост незавершённой строки между чанками:
 * граница чанка проходит где угодно, в том числе посреди UTF-8 символа —
 * поэтому декодирование делает вызывающий через TextDecoder({stream:true}).
 */
export class SseParser {
  private buf = ''
  private event = ''
  private data: string[] = []
  private id: string | undefined = undefined

  push(text: string): SseEvent[] {
    this.buf += text
    const out: SseEvent[] = []
    let idx = this.buf.indexOf('\n')
    while (idx !== -1) {
      let line = this.buf.slice(0, idx)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.buf = this.buf.slice(idx + 1)
      const done = this.line(line)
      if (done !== null) out.push(done)
      idx = this.buf.indexOf('\n')
    }
    return out
  }

  /** Хвост без завершающего перевода строки: некоторые серверы не шлют его в конце. */
  flush(): SseEvent[] {
    const out: SseEvent[] = []
    if (this.buf.length > 0) {
      const line = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf
      this.buf = ''
      const done = this.line(line)
      if (done !== null) out.push(done)
    }
    const tail = this.dispatch()
    if (tail !== null) out.push(tail)
    return out
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
    else if (field === 'id') this.id = value
    return null
  }

  private dispatch(): SseEvent | null {
    if (this.data.length === 0 && this.event === '') return null
    const ev: SseEvent = { event: this.event === '' ? 'message' : this.event, data: this.data.join('\n') }
    if (this.id !== undefined) ev.id = this.id
    this.event = ''
    this.data = []
    return ev
  }
}

/** Поток байтов ответа → поток SSE-событий. */
export async function* readSse(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  try {
    for (;;) {
      if (signal?.aborted === true) return
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield ev
    }
    for (const ev of parser.push(decoder.decode())) yield ev
    for (const ev of parser.flush()) yield ev
  } finally {
    reader.releaseLock()
  }
}

/** Тотальный разбор data: у всех трёх семейств там JSON. */
export function jsonOf(data: string): Record<string, unknown> | null {
  if (data === '' || data === '[DONE]') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

export function str(o: Record<string, unknown> | undefined, key: string): string | undefined {
  if (o === undefined) return undefined
  const v = o[key]
  return typeof v === 'string' ? v : undefined
}

export function num(o: Record<string, unknown> | undefined, key: string): number | undefined {
  if (o === undefined) return undefined
  const v = o[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function obj(
  o: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (o === undefined) return undefined
  const v = o[key]
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  return v as Record<string, unknown>
}

export function arr(o: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  if (o === undefined) return undefined
  const v = o[key]
  return Array.isArray(v) ? v : undefined
}

export function asObj(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  return v as Record<string, unknown>
}
