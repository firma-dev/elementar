/**
 * Постоянное хранилище и квоты (§7.2, §5.2).
 * При создании первого документа — persist(); при usage/quota > 0.8 — предупреждение;
 * при persist() === false — авто-экспорт раз в 7 дней.
 */
import { MS } from '@elementar/proto'
import type { DocRepo } from './repo.js'

export const QUOTA_WARN_RATIO = 0.8
/** Раз в 7 дней, если браузер отказал в постоянном хранилище. */
export const AUTO_EXPORT_INTERVAL_MS = MS.TRASH_TTL
export const SETTING_PERSIST_ASKED = 'storage.persistAsked'
export const SETTING_LAST_EXPORT = 'storage.lastAutoExportAt'

export interface StorageStatus {
  /** Ответ navigator.storage.persisted(). */
  persisted: boolean
  usage: number
  quota: number
  /** usage/quota; 0, если браузер оценку не даёт. */
  ratio: number
  /** ratio > QUOTA_WARN_RATIO: пора предлагать выгрузить архив. */
  warn: boolean
  /** API недоступно (старый Safari, приватное окно). */
  unknown: boolean
}

function storageManager(): StorageManager | null {
  const nav = globalThis.navigator as Navigator | undefined
  const sm = nav?.storage
  return sm === undefined ? null : sm
}

export async function isPersisted(): Promise<boolean> {
  const sm = storageManager()
  if (sm === null || typeof sm.persisted !== 'function') return false
  try {
    return await sm.persisted()
  } catch {
    return false
  }
}

/** Спрашивать имеет смысл один раз: повторный отказ ничего не меняет. */
export async function requestPersistence(): Promise<boolean> {
  const sm = storageManager()
  if (sm === null || typeof sm.persist !== 'function') return false
  try {
    if (typeof sm.persisted === 'function' && (await sm.persisted())) return true
    return await sm.persist()
  } catch {
    return false
  }
}

export async function storageStatus(): Promise<StorageStatus> {
  const sm = storageManager()
  const persisted = await isPersisted()
  if (sm === null || typeof sm.estimate !== 'function') {
    return { persisted, usage: 0, quota: 0, ratio: 0, warn: false, unknown: true }
  }
  try {
    const est = await sm.estimate()
    const usage = est.usage ?? 0
    const quota = est.quota ?? 0
    const ratio = quota > 0 ? usage / quota : 0
    return { persisted, usage, quota, ratio, warn: ratio > QUOTA_WARN_RATIO, unknown: quota === 0 }
  } catch {
    return { persisted, usage: 0, quota: 0, ratio: 0, warn: false, unknown: true }
  }
}

/** Чистое правило авто-экспорта: только когда постоянного хранилища нет. */
export function shouldAutoExport(
  persisted: boolean,
  lastExportAt: number | null,
  now: number,
  interval = AUTO_EXPORT_INTERVAL_MS,
): boolean {
  if (persisted) return false
  if (lastExportAt === null) return true
  return now - lastExportAt >= interval
}

export interface PersistGuardEnv {
  repo: DocRepo
  now?(): number
  /** Вызывается, когда пора выгрузить архив: UI сам решает, как именно. */
  onAutoExport?(): void | Promise<void>
  onQuotaWarning?(status: StorageStatus): void
}

export interface PersistGuard {
  /** Шаг при создании первого документа: спросить постоянное хранилище один раз. */
  ensurePersistence(): Promise<boolean>
  /** Проверка квоты и авто-экспорта; вызывается при открытии документа и после снапшота. */
  check(): Promise<StorageStatus>
  markExported(at?: number): Promise<void>
}

export function createPersistGuard(env: PersistGuardEnv): PersistGuard {
  const now = env.now ?? Date.now
  return {
    async ensurePersistence(): Promise<boolean> {
      const asked = await env.repo.getSetting<boolean>(SETTING_PERSIST_ASKED)
      if (asked === true) return isPersisted()
      const granted = await requestPersistence()
      await env.repo.setSetting(SETTING_PERSIST_ASKED, true)
      await env.repo.journal({
        at: now(),
        kind: 'quota',
        message: granted ? 'Постоянное хранилище разрешено' : 'Постоянное хранилище не дано',
      })
      return granted
    },

    async check(): Promise<StorageStatus> {
      const status = await storageStatus()
      if (status.warn) {
        env.onQuotaWarning?.(status)
        await env.repo.journal({
          at: now(),
          kind: 'quota',
          message: `Хранилище занято на ${Math.round(status.ratio * 100)}%`,
          data: { usage: status.usage, quota: status.quota },
        })
      }
      const last = (await env.repo.getSetting<number>(SETTING_LAST_EXPORT)) ?? null
      if (shouldAutoExport(status.persisted, last, now())) {
        await env.onAutoExport?.()
      }
      return status
    },

    async markExported(at: number = now()): Promise<void> {
      await env.repo.setSetting(SETTING_LAST_EXPORT, at)
      await env.repo.journal({ at, kind: 'export', message: 'Авто-экспорт архива' })
    },
  }
}
