/**
 * Готовые провайдеры слота. Смена движка — это смена строки в конфиге:
 * DeepSeek и Moonshot ходят через тот же OpenAI-совместимый адаптер,
 * что и OpenAI, и стоят в разы дешевле.
 */
import { ANTHROPIC_BASE_URL, ANTHROPIC_CAPABILITIES } from './anthropic.js'
import { ECHO_CAPABILITIES, ECHO_MODEL, ECHO_PROVIDER_ID } from './echo.js'
import { GOOGLE_BASE_URL, GOOGLE_CAPABILITIES } from './google.js'
import { OPENAI_BASE_URL, OPENAI_CAPABILITIES } from './openai-compatible.js'
import { RELAY_ALLOW } from '../transport.js'
import type { LlmCapabilities, LlmTransportConfig, ModelInfo, ProviderConfig } from '../types.js'

export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'echo'

export interface ProviderPreset {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  /** Для OpenAI-совместимых: путь чата различается (у DeepSeek он без /v1). */
  chatPath?: string
  modelsPath?: string
  /** Ollama и часть локальных движков не понимают stream_options. */
  usageOption?: boolean
  capabilities: LlmCapabilities
  models: readonly ModelInfo[]
  /** Где человек берёт ключ — показывается подписью под полем. */
  keyHint: string
  /** Локальный движок: ключ не нужен, CORS обычно открыт. */
  local?: boolean
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: ANTHROPIC_BASE_URL,
    capabilities: ANTHROPIC_CAPABILITIES,
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', context: 200_000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', context: 200_000 },
    ],
    keyHint: 'console.anthropic.com → API keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: OPENAI_BASE_URL,
    chatPath: '/v1/chat/completions',
    capabilities: OPENAI_CAPABILITIES,
    models: [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', context: 128_000 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', context: 128_000 },
    ],
    keyHint: 'platform.openai.com → API keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    capabilities: { ...OPENAI_CAPABILITIES, images: false, maxContext: 65_536 },
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3', context: 65_536 },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1', context: 65_536 },
    ],
    keyHint: 'platform.deepseek.com → API keys (дешевле остальных примерно на порядок)',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn',
    chatPath: '/v1/chat/completions',
    capabilities: { ...OPENAI_CAPABILITIES, maxContext: 131_072 },
    models: [
      { id: 'kimi-k2-0905-preview', label: 'Kimi K2', context: 131_072 },
      { id: 'moonshot-v1-32k', label: 'Moonshot v1 32k', context: 32_768 },
    ],
    keyHint: 'platform.moonshot.cn → API keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    chatPath: '/v1/chat/completions',
    capabilities: OPENAI_CAPABILITIES,
    models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek через OpenRouter', context: 65_536 }],
    keyHint: 'openrouter.ai → Keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'google',
    baseUrl: GOOGLE_BASE_URL,
    capabilities: GOOGLE_CAPABILITIES,
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', context: 1_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', context: 1_000_000 },
    ],
    keyHint: 'aistudio.google.com → API key',
  },
  {
    id: 'ollama',
    label: 'Ollama / LM Studio',
    kind: 'openai',
    baseUrl: 'http://localhost:11434',
    chatPath: '/v1/chat/completions',
    usageOption: false,
    capabilities: { ...OPENAI_CAPABILITIES, maxContext: 32_768 },
    models: [{ id: 'qwen2.5:7b', label: 'Qwen 2.5 7B (локально)', context: 32_768 }],
    keyHint: 'локальный движок — ключ не нужен',
    local: true,
  },
  {
    id: ECHO_PROVIDER_ID,
    label: 'Заглушка (без сети)',
    kind: 'echo',
    baseUrl: '',
    capabilities: ECHO_CAPABILITIES,
    models: [{ id: ECHO_MODEL, label: 'Заглушка', context: ECHO_CAPABILITIES.maxContext }],
    keyHint: 'ключ не нужен: отвечает детерминированно, в сеть не ходит',
    local: true,
  },
]

export function presetOf(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === providerId)
}

/** Умеет ли релей элементара проксировать этого провайдера (§10.2). */
export function relayable(providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RELAY_ALLOW, providerId)
}

/** По умолчанию — только direct: релей включает человек руками (§10.1). */
export function defaultTransport(): LlmTransportConfig {
  return { mode: 'direct' }
}

/** Заготовка конфига: ключ человек вписывает сам. */
export function configFromPreset(preset: ProviderPreset, apiKey = ''): ProviderConfig {
  return {
    providerId: preset.id,
    baseUrl: preset.baseUrl === '' ? undefined : preset.baseUrl,
    apiKey,
    model: preset.models[0]?.id ?? '',
    label: preset.label,
    transport: defaultTransport(),
  }
}
