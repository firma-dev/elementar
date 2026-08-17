import { RECOVERY_MAGIC } from '@elementar/core'

export type RecoveryKind = 'plain' | 'sealed' | 'not-recovery'

/**
 * Что за файл нам дали. Разбор чисто структурный: понять, нужна ли парольная фраза,
 * надо ДО попытки расшифровать, иначе человек увидит «неверный пароль» вместо «введите его».
 */
export function recoveryKind(body: string): RecoveryKind {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return 'not-recovery'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'not-recovery'
  const o = parsed as Record<string, unknown>
  if (o['elementar'] !== RECOVERY_MAGIC || o['v'] !== 1) return 'not-recovery'
  if (typeof o['link'] === 'string') return 'plain'
  if (typeof o['ct'] === 'string' && typeof o['nonce'] === 'string') return 'sealed'
  return 'not-recovery'
}

export const RECOVERY_FILE_ACCEPT = '.txt,.elementar,application/json,text/plain'
