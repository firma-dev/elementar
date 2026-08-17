import { APP_PREFIX } from '@elementar/proto'
import { docPath } from '../routes.js'

/**
 * Разбор и сборка ссылок — через ленивый импорт крипты: `@elementar/core/crypto`
 * тянет за собой argon2-обвязку и словарь парольных фраз, которым нечего делать
 * в первой отрисовке прихожей (§12.11).
 */
export async function linkToPath(input: string): Promise<string | null> {
  const { buildFragment, tryParseLink } = await import('@elementar/core')
  const parsed = tryParseLink(input.trim())
  if (parsed === null) return null
  return docPath(APP_PREFIX.planer, parsed.docId, buildFragment(parsed.linkSecret))
}

export async function keysToPath(docId: string, linkSecret: Uint8Array): Promise<string> {
  const { buildFragment } = await import('@elementar/core')
  return docPath(APP_PREFIX.planer, docId, buildFragment(linkSecret))
}
