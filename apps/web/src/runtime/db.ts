import { actorId, createRepo, openDb } from '@elementar/core'
import type { ActorId, DocCard, DocRepo } from '@elementar/core'

export const SETTING_ACTOR = 'device.actor'
export const SETTING_DEVICE_NAME = 'device.name'
export const SETTING_SYNC_DEFAULT = 'device.sync'

let repoPromise: Promise<DocRepo> | null = null

/** Одна база на весь ориджин: прихожая и все двери работают с одним хранилищем (§13.1). */
export function repo(): Promise<DocRepo> {
  if (repoPromise === null) repoPromise = openDb().then((db) => createRepo(db))
  return repoPromise
}

let actorPromise: Promise<ActorId> | null = null

/** Идентификатор устройства: один на браузер, переживает перезагрузку. */
export function deviceActor(): Promise<ActorId> {
  if (actorPromise === null)
    actorPromise = (async (): Promise<ActorId> => {
      const r = await repo()
      const saved = await r.getSetting<string>(SETTING_ACTOR)
      if (typeof saved === 'string' && saved.length === 8) return saved as ActorId
      const fresh = actorId()
      await r.setSetting(SETTING_ACTOR, fresh)
      return fresh
    })()
  return actorPromise
}

export async function deviceName(): Promise<string> {
  const r = await repo()
  return (await r.getSetting<string>(SETTING_DEVICE_NAME)) ?? ''
}

export async function setDeviceName(name: string): Promise<void> {
  const r = await repo()
  await r.setSetting(SETTING_DEVICE_NAME, name)
}

/** Последний открытый документ корпуса: цель `/p/last` из ярлыков манифеста. */
export async function lastDocOf(corpus: string): Promise<DocCard | undefined> {
  const cards = await (await repo()).listDocs()
  return cards.filter((c) => c.corpus === corpus)[0]
}
