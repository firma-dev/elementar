import { createLlmRegistry } from '@elementar/llm'
import type { LlmSlot } from '@elementar/llm'
import { repo } from '../../../runtime/db.js'

let slot: LlmSlot | null = null

/**
 * Слот модели один на устройство (§10.3): ключ лежит в настройках базы, не в документе,
 * и не попадает в экспорт.
 */
export function llmSlot(): LlmSlot {
  if (slot === null) {
    slot = createLlmRegistry({
      settings: {
        async getSetting<T>(key: string): Promise<T | undefined> {
          return (await repo()).getSetting<T>(key)
        },
        async setSetting(key: string, value: unknown): Promise<void> {
          await (await repo()).setSetting(key, value)
        },
      },
    })
    void slot.load()
  }
  return slot
}
