import { PRESENCE_TTL_MS, presenceSlot } from '@elementar/core'
import type { ActorId, ActorRecord, PresencePayload, PresenceView } from '@elementar/core'

export interface PresencePeer {
  actor: ActorId
  name: string
  /** Цвет участника: --e-actor-a / --e-actor-b (§12.9). */
  slot: 'a' | 'b'
  online: boolean
  lastSeenAt: number
  /** Где партнёр: «Быт», «Календарь». */
  where?: string
}

export function defaultViewLabel(view: PresenceView): string {
  switch (view.kind) {
    case 'list':
      return view.list
    case 'project':
      return 'Проект'
    case 'calendar':
      return 'Календарь'
    case 'today':
      return 'Сейчас'
  }
}

export interface PeersArgs {
  payloads: readonly PresencePayload[]
  actors: readonly ActorRecord[]
  /** Себя в присутствии не показываем никогда. */
  me: ActorId
  now?: number
  viewLabel?: (view: PresenceView) => string
}

/**
 * Присутствие для интерфейса: до двух участников, свои — прочь,
 * офлайн-партнёр остаётся с временем последнего появления.
 */
export function peersOf(a: PeersArgs): PresencePeer[] {
  const now = a.now ?? Date.now()
  const label = a.viewLabel ?? defaultViewLabel
  const alive = a.actors.filter((x) => x.mergedInto === undefined).map((x) => x.id)
  const byActor = new Map<ActorId, PresencePayload>()
  for (const p of a.payloads) {
    if (p.actor === a.me) continue
    const prev = byActor.get(p.actor)
    if (prev === undefined || prev.at < p.at) byActor.set(p.actor, p)
  }
  const out: PresencePeer[] = []
  for (const actor of a.actors) {
    if (actor.id === a.me || actor.mergedInto !== undefined) continue
    const payload = byActor.get(actor.id)
    const lastSeenAt = payload?.at ?? actor.lastSeenAt
    const online = payload !== undefined && now - payload.at <= PRESENCE_TTL_MS
    const peer: PresencePeer = {
      actor: actor.id,
      name: actor.name === '' ? 'Партнёр' : actor.name,
      slot: presenceSlot(alive, actor.id),
      online,
      lastSeenAt,
    }
    if (online && payload !== undefined) peer.where = label(payload.view)
    out.push(peer)
  }
  // Сначала онлайн, дальше по свежести: аватаров всего два
  out.sort((x, y) => Number(y.online) - Number(x.online) || y.lastSeenAt - x.lastSeenAt)
  return out
}
