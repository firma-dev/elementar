import { signal } from '@preact/signals'
import type { ReadonlySignal } from '@preact/signals'
import { LLM_SETTING_KEY, parseSlotSettings } from '@elementar/llm'
import { repo } from '../../../runtime/db.js'

const available = signal(false)

/**
 * Есть ли рабочая модель. Отдельно от registry.ts: проверка не должна тянуть
 * адаптеры провайдеров в первую отрисовку — весь @elementar/llm живёт в чанке агента.
 */
export const agentAvailable: ReadonlySignal<boolean> = available

export async function refreshAgentAvailability(): Promise<void> {
  try {
    const raw = await (await repo()).getSetting(LLM_SETTING_KEY)
    const slot = parseSlotSettings(raw)
    const active = slot.configs.find((c) => c.providerId === slot.activeId)
    available.value = active !== undefined && active.model !== '' && active.apiKey !== ''
  } catch {
    available.value = false
  }
}
