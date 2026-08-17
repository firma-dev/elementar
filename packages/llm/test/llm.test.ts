import { describe, expect, it } from 'vitest'
import { API_ORIGIN } from '@elementar/proto'
import {
  LLM_SETTING_KEY,
  LlmError,
  SseParser,
  createAnthropicDecoder,
  createAnthropicProvider,
  createLlmRegistry,
  createOpenAiDecoder,
  createProvider,
  configFromPreset,
  memoryKeyStore,
  parseSlotSettings,
  presetOf,
  redactConfig,
  relayAllows,
  resolveEndpoint,
  toAnthropicBody,
  toOpenAiBody,
} from '../src/index.js'
import type { FetchLike, LlmEvent, ProviderConfig } from '../src/index.js'

function sseResponse(lines: string): Response {
  return new Response(lines, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function drain(it: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('SSE', () => {
  it('склеивает событие, разрезанное посреди строки', () => {
    const p = new SseParser()
    expect(p.push('event: message_st')).toEqual([])
    const evs = [...p.push('art\ndata: {"a":1}\n\n')]
    expect(evs).toEqual([{ event: 'message_start', data: '{"a":1}' }])
  })

  it('пропускает комментарии и склеивает многострочные data', () => {
    const p = new SseParser()
    const evs = p.push(': ping\ndata: одна\ndata: две\n\n')
    expect(evs).toEqual([{ event: 'message', data: 'одна\nдве' }])
  })

  it('отдаёт хвост без завершающего перевода строки', () => {
    const p = new SseParser()
    expect(p.push('data: x')).toEqual([])
    expect(p.flush()).toEqual([{ event: 'message', data: 'x' }])
  })
})

describe('транспорт', () => {
  it('direct собирает адрес провайдера', () => {
    const e = resolveEndpoint({
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      path: '/chat/completions',
      transport: { mode: 'direct' },
    })
    expect(e).toEqual({ url: 'https://api.deepseek.com/chat/completions', mode: 'direct', viaRelay: false })
  })

  it('own-relay без адреса — ошибка, а не тихий фолбэк', () => {
    expect(() =>
      resolveEndpoint({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com',
        path: '/v1/chat/completions',
        transport: { mode: 'own-relay' },
      }),
    ).toThrow(LlmError)
  })

  it('релей элементара знает только allowlist', () => {
    expect(relayAllows('anthropic', '/v1/messages')).toBe(true)
    expect(relayAllows('anthropic', '/v1/complete')).toBe(false)
    expect(relayAllows('google', '/v1beta/models/x:streamGenerateContent')).toBe(false)
    const e = resolveEndpoint({
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      path: '/v1/messages',
      transport: { mode: 'elm-relay' },
    })
    expect(e.url).toBe(`${API_ORIGIN}/v1/llm/anthropic`)
    expect(e.viaRelay).toBe(true)
  })

  it('CORS-обрыв не переключает транспорт на релей', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = (url) => {
      seen.push(url)
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    const config: ProviderConfig = {
      providerId: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      transport: { mode: 'direct' },
    }
    const provider = createAnthropicProvider(config, { fetch: fetchImpl })
    const events = await drain(
      provider.stream({ model: config.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    )
    expect(events).toEqual([{ type: 'error', code: 'cors', message: 'Failed to fetch' }])
    // единственная попытка и только прямой адрес: релей сам собой не подставляется
    expect(seen).toEqual(['https://api.anthropic.com/v1/messages'])
    expect(config.transport.mode).toBe('direct')
  })
})

describe('адаптер Anthropic', () => {
  it('склеивает подряд идущие tool_result в одно сообщение', () => {
    const body = toAnthropicBody({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'сделай' }] },
        { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'a', input: {} }] },
        { role: 'tool', toolCallId: 't1', name: 'a', content: '1' },
        { role: 'tool', toolCallId: 't2', name: 'b', content: '2' },
      ],
      maxTokens: 16,
    })
    expect(body.messages).toHaveLength(3)
    expect(body.messages[2]?.content).toHaveLength(2)
    expect(body.max_tokens).toBe(16)
  })

  it('собирает вызов инструмента из кусков JSON', () => {
    const decode = createAnthropicDecoder()
    const evs: LlmEvent[] = []
    evs.push(...decode('message_start', { message: { model: 'claude', usage: { input_tokens: 7 } } }))
    evs.push(...decode('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'propose_tasks' } }))
    evs.push(...decode('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"items"' } }))
    evs.push(...decode('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ':["a"]}' } }))
    evs.push(...decode('content_block_stop', { index: 0 }))
    evs.push(...decode('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }))
    evs.push(...decode('message_stop', {}))
    expect(evs[0]).toEqual({ type: 'start', model: 'claude' })
    expect(evs).toContainEqual({ type: 'tool_call', id: 'tu_1', name: 'propose_tasks', input: { items: ['a'] } })
    expect(evs[evs.length - 1]).toEqual({ type: 'stop', reason: 'tool_use' })
  })

  it('читает поток целиком', async () => {
    const body = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":4}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"при"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"вет"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
    const provider = createAnthropicProvider(
      { providerId: 'anthropic', apiKey: 'k', model: 'claude-haiku-4-5', transport: { mode: 'direct' } },
      { fetch: () => Promise.resolve(sseResponse(body)) },
    )
    const evs = await drain(
      provider.stream({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    )
    const text = evs.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : '')).join('')
    expect(text).toBe('привет')
    expect(evs.at(-1)).toEqual({ type: 'stop', reason: 'end' })
  })

  it('ошибку HTTP переводит в код', async () => {
    const provider = createAnthropicProvider(
      { providerId: 'anthropic', apiKey: 'bad', model: 'claude-haiku-4-5', transport: { mode: 'direct' } },
      {
        fetch: () =>
          Promise.resolve(
            new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 }),
          ),
      },
    )
    const evs = await drain(
      provider.stream({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    )
    expect(evs[0]).toMatchObject({ type: 'error', code: 'auth' })
  })
})

describe('адаптер OpenAI-совместимый', () => {
  it('дешёвый китайский эндпоинт — это только другой baseUrl и путь', () => {
    const preset = presetOf('deepseek')
    expect(preset?.kind).toBe('openai')
    expect(preset?.baseUrl).toBe('https://api.deepseek.com')
    expect(preset?.chatPath).toBe('/chat/completions')
    const config = configFromPreset(preset!, 'sk-test')
    const provider = createProvider(config)
    expect(provider.id).toBe('deepseek')
    expect(provider.capabilities.tools).toBe(true)
  })

  it('раскладывает сообщения и инструменты', () => {
    const body = toOpenAiBody({
      model: 'deepseek-chat',
      system: 'служебное',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'сделай' }] },
        { role: 'tool', toolCallId: 'c1', name: 'list_tasks', content: '[]' },
      ],
      tools: [{ name: 'list_tasks', description: 'задачи', input: { type: 'object' } }],
      toolChoice: { name: 'list_tasks' },
    })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'служебное' })
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'list_tasks' } })
  })

  it('собирает tool_calls по индексу и отдаёт стоп', () => {
    const d = createOpenAiDecoder()
    const evs: LlmEvent[] = []
    evs.push(...d.push({ model: 'deepseek-chat', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'propose_tasks', arguments: '{"it' } }] } }] }))
    evs.push(...d.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ems":2}' } }] } }] }))
    evs.push(...d.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    expect(evs).toContainEqual({ type: 'tool_call', id: 'c1', name: 'propose_tasks', input: { items: 2 } })
    expect(evs.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' })
  })
})

describe('хранение ключа', () => {
  it('в описании конфига нет ключа и его длины', () => {
    const c: ProviderConfig = {
      providerId: 'deepseek',
      apiKey: 'sk-очень-секретный',
      model: 'deepseek-chat',
      transport: { mode: 'direct' },
    }
    const safe = redactConfig(c)
    expect(Object.prototype.hasOwnProperty.call(safe, 'apiKey')).toBe(false)
    expect(JSON.stringify(safe)).not.toContain('sk-')
    expect(JSON.stringify(safe)).not.toContain(String(c.apiKey.length))
  })

  it('мусор из хранилища не ломает слот', () => {
    const s = parseSlotSettings({ v: 1, configs: [{ providerId: 42 }, { providerId: 'echo', model: 'echo-1' }], activeId: 'нет' })
    expect(s.configs).toHaveLength(1)
    expect(s.configs[0]?.apiKey).toBe('')
    expect(s.activeId).toBeNull()
  })

  it('ключ настроек — тот, что вырезается из экспорта', () => {
    expect(LLM_SETTING_KEY).toBe('llm.slot')
  })
})

describe('реестр', () => {
  it('поднимает конфиг, отдаёт провайдера и проверяет связь', async () => {
    const store = memoryKeyStore()
    const registry = createLlmRegistry({ store })
    await registry.load()
    expect(registry.resolve()).toBeNull()
    await registry.add(configFromPreset(presetOf('echo')!))
    expect(registry.ready.value).toBe(true)
    expect(registry.active.value?.providerId).toBe('echo')
    const provider = registry.resolve()
    expect(provider?.id).toBe('echo')
    const probe = await registry.probe(registry.active.value!)
    expect(probe.ok).toBe(true)

    // перезагрузка из того же стора возвращает слот на место
    const again = createLlmRegistry({ store })
    await again.load()
    expect(again.active.value?.model).toBe('echo-1')

    await again.remove('echo')
    expect(again.active.value).toBeNull()
    expect(again.ready.value).toBe(false)
  })

  it('без ключа слот не готов — кнопки агента не будет', async () => {
    const registry = createLlmRegistry()
    await registry.load()
    await registry.add(configFromPreset(presetOf('deepseek')!))
    expect(registry.ready.value).toBe(false)
    await registry.update('deepseek', { apiKey: 'sk-1' })
    expect(registry.ready.value).toBe(true)
  })
})
