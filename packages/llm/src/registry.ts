/** Реестр слота: список конфигов, активный, проверка связи (§10.3). */
import { computed, signal } from '@preact/signals-core'
import type { ReadonlySignal } from '@preact/signals-core'
import { LlmError, errorOf } from './errors.js'
import { createKeyStore, emptySlotSettings, hasKey, memoryKeyStore } from './keystore.js'
import type { LlmKeyStore, LlmSettingsStore, LlmSlotSettings } from './keystore.js'
import { createProvider } from './providers/index.js'
import { presetOf } from './providers/presets.js'
import type { FetchLike, LlmProvider, LlmRegistry, ModelInfo, ProbeResult, ProviderConfig } from './types.js'

export interface RegistryEnv {
  store?: LlmKeyStore
  /** DocRepo подходит структурно: getSetting/setSetting. */
  settings?: LlmSettingsStore
  fetch?: FetchLike
  challenge?(): string | null
}

export interface LlmSlot extends LlmRegistry {
  /** Поднять настройки с диска. Вызывается один раз при открытии слота. */
  load(): Promise<void>
  /** Обновить существующий конфиг (ключ, модель, транспорт). */
  update(providerId: string, patch: Partial<Omit<ProviderConfig, 'providerId'>>): Promise<void>
  /** Есть ли рабочий слот: агента без него не показываем вовсе (§12.10). */
  readonly ready: ReadonlySignal<boolean>
  clear(): Promise<void>
}

export function createLlmRegistry(env: RegistryEnv = {}): LlmSlot {
  const store: LlmKeyStore =
    env.store ?? (env.settings !== undefined ? createKeyStore(env.settings) : memoryKeyStore())
  const state = signal<LlmSlotSettings>(emptySlotSettings())
  const configs = computed<readonly ProviderConfig[]>(() => state.value.configs)
  const active = computed<ProviderConfig | null>(() => {
    const id = state.value.activeId
    if (id === null) return null
    return state.value.configs.find((c) => c.providerId === id) ?? null
  })
  const ready = computed<boolean>(() => {
    const c = active.value
    if (c === null) return false
    const preset = presetOf(c.providerId)
    return c.model !== '' && (hasKey(c) || preset?.local === true)
  })

  const persist = async (next: LlmSlotSettings): Promise<void> => {
    state.value = next
    await store.save(next)
  }

  const deps = {
    ...(env.fetch !== undefined ? { fetch: env.fetch } : {}),
    ...(env.challenge !== undefined ? { challenge: env.challenge } : {}),
  }

  return {
    configs,
    active,
    ready,

    async load() {
      state.value = await store.load()
    },

    async add(c) {
      const rest = state.value.configs.filter((x) => x.providerId !== c.providerId)
      await persist({ v: 1, configs: [...rest, c], activeId: c.providerId })
    },

    async update(providerId, patch) {
      const configs = state.value.configs.map((c) =>
        c.providerId === providerId ? { ...c, ...patch, providerId } : c,
      )
      await persist({ ...state.value, configs })
    },

    async remove(id) {
      const configs = state.value.configs.filter((c) => c.providerId !== id)
      const activeId = state.value.activeId === id ? (configs[0]?.providerId ?? null) : state.value.activeId
      await persist({ v: 1, configs, activeId })
    },

    async setActive(id) {
      if (!state.value.configs.some((c) => c.providerId === id)) {
        throw new LlmError('model', `провайдер ${id} не настроен`)
      }
      await persist({ ...state.value, activeId: id })
    },

    async probe(c): Promise<ProbeResult> {
      const provider = createProvider(c, deps)
      try {
        // Список моделей ходит только напрямую: в режиме релея он ничего не докажет
        if (provider.listModels !== undefined && c.transport.mode === 'direct') {
          const models = await provider.listModels()
          if (models.length > 0) return { ok: true, models }
        }
        // Список моделей отдают не все: тогда проверяем самым коротким запросом
        const models: ModelInfo[] = presetOf(c.providerId)?.models.slice() ?? []
        for await (const ev of provider.stream(
          { model: c.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: 1 },
        )) {
          if (ev.type === 'error') return { ok: false, code: ev.code }
          if (ev.type === 'stop') break
        }
        return { ok: true, models }
      } catch (e) {
        return { ok: false, code: errorOf(e).code }
      }
    },

    resolve(): LlmProvider | null {
      const c = active.value
      if (c === null || !ready.value) return null
      return createProvider(c, deps)
    },

    async clear() {
      await persist(emptySlotSettings())
    },
  }
}
