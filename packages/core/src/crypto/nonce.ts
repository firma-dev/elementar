/**
 * Сессионный источник nonce (§4.4): nonce = sessionTag(8, CSPRNG при старте) ‖ counter(4, BE).
 * Ничего не персистится: восстановление бэкапа профиля безопасно по построению —
 * старый sessionTag мёртв, а значит пара (key, nonce) не повторится.
 */
import { SIZES } from '@elementar/proto'
import { randomBytes } from './keys.js'

export interface NonceSource {
  /** Синхронно, без ожидания, без IO. */
  next(): Uint8Array
  /** 8 байт, живёт только в памяти. */
  readonly sessionTag: Uint8Array
  /** Новый sessionTag и counter = 0. Вызывается при counter > 2^32 − 2^20. */
  rotate(): void
}

/** Порог ротации: 2^32 − 2^20. */
export const NONCE_COUNTER_LIMIT = 2 ** 32 - 2 ** 20

/**
 * sessionTag генерируется здесь и НИКОГДА не пишется на диск.
 * `startCounter` существует только для тестов переполнения счётчика.
 */
export function createNonceSource(opts: { startCounter?: number } = {}): NonceSource {
  let tag = randomBytes(SIZES.SESSION_TAG_BYTES)
  let counter = 0
  const start = opts.startCounter
  if (start !== undefined) {
    if (!Number.isInteger(start) || start < 0 || start >= NONCE_COUNTER_LIMIT) {
      throw new Error('startCounter out of range')
    }
    counter = start
  }

  const src: NonceSource = {
    get sessionTag(): Uint8Array {
      return tag
    },
    rotate(): void {
      tag = randomBytes(SIZES.SESSION_TAG_BYTES)
      counter = 0
    },
    next(): Uint8Array {
      if (counter >= NONCE_COUNTER_LIMIT) src.rotate()
      const nonce = new Uint8Array(SIZES.NONCE_BYTES)
      nonce.set(tag, 0)
      const c = counter
      nonce[8] = (c >>> 24) & 0xff
      nonce[9] = (c >>> 16) & 0xff
      nonce[10] = (c >>> 8) & 0xff
      nonce[11] = c & 0xff
      counter = c + 1
      return nonce
    },
  }
  return src
}
