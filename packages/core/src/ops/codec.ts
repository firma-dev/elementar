import { isHlc } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { JsonValue } from '../schema/types.js'
import { canonicalJson } from '../doc/state.js'
import { byteLengthOfUtf8, utf8 } from '../util/bytes.js'
import { isOpKind } from './types.js'
import type { AnyOp, Op, UnknownOp } from './types.js'

/**
 * Сериализация операций — компактный JSON с детерминированным порядком ключей:
 * от неё зависит хеш-цепочка лога (§6.11), поэтому «просто JSON.stringify» нельзя.
 */
export function encodeOp(op: AnyOp): string {
  return canonicalJson(op)
}

export function encodeOps(ops: readonly AnyOp[]): string {
  return `[${ops.map(encodeOp).join(',')}]`
}

export function opsJsonBytes(ops: readonly AnyOp[]): Uint8Array {
  return utf8(encodeOps(ops))
}

export function opBytes(op: AnyOp): number {
  return byteLengthOfUtf8(encodeOp(op))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isJsonValue(v: unknown): v is JsonValue {
  if (v === null) return true
  const t = typeof v
  if (t === 'boolean' || t === 'string') return true
  if (t === 'number') return Number.isFinite(v as number)
  if (Array.isArray(v)) return v.every(isJsonValue)
  if (isPlainObject(v)) return Object.values(v).every(isJsonValue)
  return false
}

function isStringRecord(v: unknown): v is Record<string, JsonValue> {
  return isPlainObject(v) && Object.values(v).every(isJsonValue)
}

function isHlcRecord(v: unknown): v is Record<string, HlcString> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string')
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * Разбор одной операции. Неизвестный `k` — не ошибка: такая операция сохраняется
 * как есть (у партнёра может быть более новая версия приложения).
 * Возвращает null только на структурном мусоре.
 */
export function parseOp(raw: unknown): AnyOp | null {
  if (!isPlainObject(raw)) return null
  const i = raw['i']
  const k = raw['k']
  if (typeof i !== 'string' || !isHlc(i)) return null
  if (typeof k !== 'string' || k.length === 0) return null
  if (!isOpKind(k)) {
    if (!Object.values(raw).every((v) => v === undefined || isJsonValue(v))) return null
    return { ...(raw as Record<string, JsonValue>), i, k } as UnknownOp
  }
  if (k === 'm') {
    if (!isStringRecord(raw['v'])) return null
    const op: Op = { i, k, v: raw['v'] }
    if (isHlcRecord(raw['b'])) op.b = raw['b']
    return op
  }
  const c = raw['c']
  const r = raw['r']
  if (typeof c !== 'string' || typeof r !== 'string') return null
  switch (k) {
    case 's': {
      if (!isStringRecord(raw['v'])) return null
      const op: Op = { i, k, c, r, v: raw['v'] }
      if (isHlcRecord(raw['b'])) op.b = raw['b']
      return op
    }
    case 'd':
      return { i, k, c, r }
    case 'u':
      return { i, k, c, r }
    case 'o': {
      const o = raw['o']
      const g = raw['g']
      const op: Op = { i, k, c, r }
      if (typeof o === 'string') op.o = o
      if (typeof g === 'string') op.g = g
      return op
    }
    case 'g+':
    case 'g-': {
      const p = raw['p']
      const e = raw['e']
      if (typeof p !== 'string' || !isStringArray(e)) return null
      return { i, k, c, r, p, e }
    }
    default:
      return null
  }
}

export function decodeOp(json: string): AnyOp | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  return parseOp(parsed)
}

/** Тотальный разбор пачки: битые элементы отбрасываются, остальные применяются. */
export function decodeOps(json: string): AnyOp[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: AnyOp[] = []
  for (const item of parsed) {
    const op = parseOp(item)
    if (op !== null) out.push(op)
  }
  return out
}
