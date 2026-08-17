/**
 * Где живёт ключ (§10.3): стор `settings` в IndexedDB ЭТОГО устройства.
 * Не синхронизируется, не попадает в документ, не попадает в экспорт
 * (вырезается явно), не попадает в exportRecovery, не логируется даже по длине.
 */
import { isLlmTransportMode, parseProviderConfig } from './parse.js'
import type { ProviderConfig } from './types.js'

export const LLM_SETTING_KEY = 'llm.slot'

/** Ключи настроек, которые обязан вырезать любой экспорт. */
export const EXPORT_EXCLUDED_SETTINGS: readonly string[] = [LLM_SETTING_KEY]

export interface LlmSlotSettings {
  v: 1
  configs: ProviderConfig[]
  activeId: string | null
}

export function emptySlotSettings(): LlmSlotSettings {
  return { v: 1, configs: [], activeId: null }
}

/** Минимальный контракт стора настроек: DocRepo подходит структурно. */
export interface LlmSettingsStore {
  getSetting<T>(key: string): Promise<T | undefined>
  setSetting(key: string, value: unknown): Promise<void>
}

export interface LlmKeyStore {
  load(): Promise<LlmSlotSettings>
  save(s: LlmSlotSettings): Promise<void>
}

export function parseSlotSettings(raw: unknown): LlmSlotSettings {
  if (typeof raw !== 'object' || raw === null) return emptySlotSettings()
  const o = raw as Record<string, unknown>
  const list = Array.isArray(o['configs']) ? o['configs'] : []
  const configs: ProviderConfig[] = []
  for (const item of list) {
    const c = parseProviderConfig(item)
    if (c !== null) configs.push(c)
  }
  const activeRaw = o['activeId']
  const activeId =
    typeof activeRaw === 'string' && configs.some((c) => c.providerId === activeRaw) ? activeRaw : null
  return { v: 1, configs, activeId }
}

export function createKeyStore(store: LlmSettingsStore): LlmKeyStore {
  return {
    async load() {
      const raw = await store.getSetting<unknown>(LLM_SETTING_KEY)
      return parseSlotSettings(raw)
    },
    async save(s) {
      await store.setSetting(LLM_SETTING_KEY, s)
    },
  }
}

/** Для тестов и режима «без хранилища»: настройки живут только в памяти вкладки. */
export function memoryKeyStore(initial?: LlmSlotSettings): LlmKeyStore {
  let state: LlmSlotSettings = initial ?? emptySlotSettings()
  return {
    load: () => Promise.resolve(parseSlotSettings(state)),
    save: (s) => {
      state = s
      return Promise.resolve()
    },
  }
}

export function hasKey(c: ProviderConfig): boolean {
  return c.apiKey.trim() !== ''
}

/**
 * Безопасное описание конфига: без ключа и без его длины. Именно эта форма
 * уходит в журнал и в экспорт.
 */
export function redactConfig(c: ProviderConfig): Omit<ProviderConfig, 'apiKey'> {
  const out: Omit<ProviderConfig, 'apiKey'> = {
    providerId: c.providerId,
    model: c.model,
    transport: { mode: c.transport.mode },
  }
  if (c.baseUrl !== undefined) out.baseUrl = c.baseUrl
  if (c.label !== undefined) out.label = c.label
  if (c.transport.relayUrl !== undefined) out.transport.relayUrl = c.transport.relayUrl
  return out
}

export function redactSlotSettings(s: LlmSlotSettings): {
  v: 1
  configs: Array<Omit<ProviderConfig, 'apiKey'>>
  activeId: string | null
} {
  return { v: 1, configs: s.configs.map(redactConfig), activeId: s.activeId }
}

export { isLlmTransportMode }
