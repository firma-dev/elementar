/** Разбор недоверенного содержимого хранилища: настройки слота могли быть испорчены. */
import type { LlmTransportConfig, ProviderConfig } from './types.js'

export function isLlmTransportMode(v: unknown): v is LlmTransportConfig['mode'] {
  return v === 'direct' || v === 'own-relay' || v === 'elm-relay'
}

export function parseTransport(raw: unknown): LlmTransportConfig {
  if (typeof raw !== 'object' || raw === null) return { mode: 'direct' }
  const o = raw as Record<string, unknown>
  const mode = isLlmTransportMode(o['mode']) ? o['mode'] : 'direct'
  const relayUrl = o['relayUrl']
  if (mode === 'own-relay' && typeof relayUrl === 'string' && relayUrl !== '') {
    return { mode, relayUrl }
  }
  return { mode }
}

export function parseProviderConfig(raw: unknown): ProviderConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const providerId = o['providerId']
  const apiKey = o['apiKey']
  const model = o['model']
  if (typeof providerId !== 'string' || providerId === '') return null
  if (typeof model !== 'string') return null
  const out: ProviderConfig = {
    providerId,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    model,
    transport: parseTransport(o['transport']),
  }
  const baseUrl = o['baseUrl']
  if (typeof baseUrl === 'string' && baseUrl !== '') out.baseUrl = baseUrl
  const label = o['label']
  if (typeof label === 'string' && label !== '') out.label = label
  return out
}
