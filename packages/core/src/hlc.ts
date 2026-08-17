import type { ActorId } from './id.js'

/** "0193f1a2b3c4-0007-k3f9x1m2" — лексикографически сортируемая метка и одновременно OpId. */
export type HlcString = string

export interface Hlc {
  wall: number
  ctr: number
  actor: ActorId
}

export const HLC_CTR_MAX = 0xffff
/** Кривые часы: расхождение больше пяти минут — повод сказать об этом человеку (§6.2). */
export const HLC_DRIFT_WARN_MS = 300_000
/** Меньше любой настоящей метки: пустой актор сортируется раньше любого непустого. */
export const HLC_ZERO: HlcString = '000000000000-0000-'

function hex(n: number, width: number): string {
  return Math.max(0, Math.floor(n)).toString(16).padStart(width, '0')
}

export function encodeHlc(h: Hlc): HlcString {
  return `${hex(h.wall, 12)}-${hex(h.ctr, 4)}-${h.actor}`
}

export function decodeHlc(s: HlcString): Hlc | null {
  if (s.length < 18) return null
  if (s[12] !== '-' || s[17] !== '-') return null
  const wallHex = s.slice(0, 12)
  const ctrHex = s.slice(13, 17)
  if (!/^[0-9a-f]{12}$/.test(wallHex) || !/^[0-9a-f]{4}$/.test(ctrHex)) return null
  return { wall: parseInt(wallHex, 16), ctr: parseInt(ctrHex, 16), actor: s.slice(18) }
}

export function isHlc(s: unknown): s is HlcString {
  return typeof s === 'string' && decodeHlc(s) !== null
}

/** Актор — хвост метки; читается без разбора всей строки. */
export function hlcActor(s: HlcString): ActorId {
  return s.length > 18 ? s.slice(18) : ''
}

export function hlcWall(s: HlcString): number {
  const h = decodeHlc(s)
  return h === null ? 0 : h.wall
}

/** Тотальный порядок: сравнение строк, тай-брейк по актору встроен в хвост. */
export function compareHlc(a: HlcString, b: HlcString): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function maxHlc(a: HlcString | undefined, b: HlcString | undefined): HlcString | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

export function minHlc(a: HlcString | undefined, b: HlcString | undefined): HlcString | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a <= b ? a : b
}

export interface ClockState {
  wall: number
  ctr: number
}

/**
 * Гибридные логические часы (§6.2). Серверное время в порядке не участвует никогда (§6.3):
 * единственный источник порядка — эти метки внутри шифротекста.
 */
export class Clock {
  readonly actor: ActorId
  #wall: number
  #ctr: number
  #drift = 0
  #nowMs: () => number

  constructor(actor: ActorId, persisted?: ClockState, nowMs: () => number = Date.now) {
    this.actor = actor
    this.#wall = persisted?.wall ?? 0
    this.#ctr = persisted?.ctr ?? 0
    this.#nowMs = nowMs
  }

  /** Насколько наши часы отстают от увиденных чужих, мс. */
  get drift(): number {
    return this.#drift
  }

  get state(): ClockState {
    return { wall: this.#wall, ctr: this.#ctr }
  }

  now(): Hlc {
    const pt = this.#nowMs()
    if (pt > this.#wall) {
      this.#wall = pt
      this.#ctr = 0
    } else {
      this.#ctr = this.#ctr + 1
    }
    this.#normalize()
    return { wall: this.#wall, ctr: this.#ctr, actor: this.actor }
  }

  tick(): HlcString {
    return encodeHlc(this.now())
  }

  /** Увидели чужую метку — подтягиваем часы, чтобы наши следующие правки были «после». */
  observe(remote: HlcString): void {
    const r = decodeHlc(remote)
    if (r === null) return
    const pt = this.#nowMs()
    if (r.wall - pt > this.#drift) this.#drift = r.wall - pt
    const next = Math.max(this.#wall, r.wall, pt)
    if (next === this.#wall && next === r.wall) this.#ctr = Math.max(this.#ctr, r.ctr) + 1
    else if (next === this.#wall) this.#ctr = this.#ctr + 1
    else if (next === r.wall) this.#ctr = r.ctr + 1
    else this.#ctr = 0
    this.#wall = next
    this.#normalize()
  }

  /** Переполнение 16-битного счётчика обязано двигать wall, иначе метки перестанут быть уникальными. */
  #normalize(): void {
    while (this.#ctr > HLC_CTR_MAX) {
      this.#wall = this.#wall + 1
      this.#ctr = 0
    }
  }
}
