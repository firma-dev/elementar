import { createAnthropicProvider } from './anthropic.js'
import { createEchoProvider } from './echo.js'
import { createGoogleProvider } from './google.js'
import { createOpenAiProvider } from './openai-compatible.js'
import type { OpenAiOptions } from './openai-compatible.js'
import { presetOf } from './presets.js'
import type { ProviderDeps } from './deps.js'
import type { LlmProvider, ProviderConfig } from '../types.js'

/** Конфиг → готовый провайдер. Незнакомый providerId считается OpenAI-совместимым. */
export function createProvider(config: ProviderConfig, deps: ProviderDeps = {}): LlmProvider {
  const preset = presetOf(config.providerId)
  switch (preset?.kind) {
    case 'anthropic':
      return createAnthropicProvider(config, deps)
    case 'google':
      return createGoogleProvider(config, deps)
    case 'echo':
      return createEchoProvider(config)
    default: {
      const opts: OpenAiOptions = {}
      if (preset?.chatPath !== undefined) opts.chatPath = preset.chatPath
      if (preset?.modelsPath !== undefined) opts.modelsPath = preset.modelsPath
      if (preset?.usageOption !== undefined) opts.usageOption = preset.usageOption
      if (preset?.capabilities !== undefined) opts.capabilities = preset.capabilities
      return createOpenAiProvider(config, deps, opts)
    }
  }
}

export { createAnthropicProvider, createEchoProvider, createGoogleProvider, createOpenAiProvider }
export type { ProviderDeps, OpenAiOptions }
