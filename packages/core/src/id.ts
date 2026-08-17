import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8 } from './util/bytes.js'

/** 8 символов base62, одно устройство. */
export type ActorId = string
/** 16 символов base62, лексикографически сортируем по времени создания. */
export type RecordId = string

/** Порядок символов совпадает с порядком их кодов: сравнение строк = сравнение чисел. */
export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const ACTOR_ID_CHARS = 8
export const RECORD_ID_CHARS = 16
/** Столько символов base62 отведено под метку времени в recordId: 62^7 > год 2081. */
export const RECORD_ID_TIME_CHARS = 7

const BASE62_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE62].map((ch, i) => [ch, i] as const),
)

export function isBase62(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!BASE62_INDEX.has(s[i] as string)) return false
  return s.length > 0
}

export function isActorId(s: string): boolean {
  return s.length === ACTOR_ID_CHARS && isBase62(s)
}

export function isRecordId(s: string): boolean {
  return s.length === RECORD_ID_CHARS && isBase62(s)
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Равномерная выборка символов base62 без модульного смещения. */
export function randomBase62(n: number): string {
  let out = ''
  while (out.length < n) {
    const buf = randomBytes(n * 2)
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const v = buf[i] as number
      if (v >= 248) continue // 248 = 4 * 62, остаток дал бы смещение
      out += BASE62[v % 62]
    }
  }
  return out
}

/** Число → base62 фиксированной ширины (старший разряд первым). */
export function base62FromNumber(value: number, width: number): string {
  let n = Math.max(0, Math.floor(value))
  let out = ''
  for (let i = 0; i < width; i++) {
    out = (BASE62[n % 62] as string) + out
    n = Math.floor(n / 62)
  }
  return out
}

export function base62FromBytes(bytes: Uint8Array, width: number): string {
  let acc = 0n
  for (let i = 0; i < bytes.length; i++) acc = (acc << 8n) | BigInt(bytes[i] as number)
  let out = ''
  for (let i = 0; i < width; i++) {
    out = (BASE62[Number(acc % 62n)] as string) + out
    acc /= 62n
  }
  return out
}

/** Идентификатор устройства. Генерируется один раз и живёт в `_actors` (§6.14). */
export function actorId(): ActorId {
  return randomBase62(ACTOR_ID_CHARS)
}

/**
 * Идентификатор записи: 7 символов времени + 9 случайных.
 * Сортируемость нужна как вторичный ключ порядка (§6.4).
 */
export function recordId(now: number = Date.now()): RecordId {
  return (
    base62FromNumber(now, RECORD_ID_TIME_CHARS) + randomBase62(RECORD_ID_CHARS - RECORD_ID_TIME_CHARS)
  )
}

/**
 * Детерминированный recordId экземпляра серии (§6.9): HMAC-SHA256, усечение до 16 base62.
 * Два устройства, независимо породившие один и тот же повтор, получают один id,
 * и обычный LWW склеивает записи без кода дедупа.
 */
export function seriesRecordId(seriesId: RecordId, occurrenceIndex: number): RecordId {
  const idx = Math.trunc(occurrenceIndex)
  const mac = hmac(sha256, utf8(seriesId), utf8(`elementar/1/series:${idx}`))
  // 12 байт → 96 бит энтропии, из них берём 16 символов base62 (~95 бит)
  return base62FromBytes(mac.subarray(0, 12), RECORD_ID_CHARS)
}
