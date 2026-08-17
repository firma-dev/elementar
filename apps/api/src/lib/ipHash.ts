/**
 * Хеширование IP-префиксов (§9.2). Сырой IP не покидает изолят и никуда не пишется:
 * наружу уходит только b32(HMAC(HKDF(ELM_IP_PEPPER, 'YYYY-MM-DD'), prefix)[0..16]).
 * Перец ротируется по дням — кросс-дневная корреляция невозможна.
 */
import { C } from '@elementar/proto'
import { encodeB32 } from './b32.js'
import { fnv1a, hkdfSha256, hmacSha256 } from './hash.js'

const utf8 = new TextEncoder()
const PREFIX_HASH_BYTES = 16

export function clientIp(req: Request): string {
  const h = req.headers
  return (h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0] ?? '').trim()
}

export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function isV6(ip: string): boolean {
  return ip.includes(':')
}

/** Гранулярность для challenge: IPv4 → /24, IPv6 → /64. */
export function challengePrefix(ip: string): string {
  if (ip === '') return 'unknown'
  if (isV6(ip)) return v6Prefix64(ip)
  const parts = ip.split('.')
  if (parts.length !== 4) return ip
  return `${parts[0] ?? '0'}.${parts[1] ?? '0'}.${parts[2] ?? '0'}.0/24`
}

/** Гранулярность для жёсткого блока: IPv4 — полный адрес, IPv6 — всё те же /64 (§9.8). */
export function blockPrefix(ip: string): string {
  if (ip === '') return 'unknown'
  return isV6(ip) ? v6Prefix64(ip) : ip
}

function v6Prefix64(ip: string): string {
  const groups = expandV6(ip)
  return `${groups.slice(0, 4).join(':')}::/64`
}

function expandV6(ip: string): string[] {
  const bare = ip.split('%')[0] ?? ip
  const [head = '', tail = ''] = bare.includes('::') ? bare.split('::') : [bare, '']
  const h = head === '' ? [] : head.split(':')
  const t = bare.includes('::') ? (tail === '' ? [] : tail.split(':')) : []
  const fill = Math.max(0, 8 - h.length - t.length)
  const out = [...h, ...new Array<string>(fill).fill('0'), ...t]
  return out.slice(0, 8).map((g) => (g === '' ? '0' : g.toLowerCase()))
}

/** Рабочий перец дня. Пустой ELM_IP_PEPPER допустим только в dev — тогда перец нулевой. */
export async function dailyPepper(pepper: string, day: string): Promise<Uint8Array> {
  return hkdfSha256(utf8.encode(pepper), new Uint8Array(0), utf8.encode(day), 32)
}

export async function prefixHash(dailyKey: Uint8Array, prefix: string): Promise<string> {
  const mac = await hmacSha256(dailyKey, utf8.encode(prefix))
  return encodeB32(mac.slice(0, PREFIX_HASH_BYTES))
}

/** shard = fnv1a(prefixHash) % 256 (§9.2). */
export function shardName(prefixHashB32: string): string {
  return `lim:${fnv1a(prefixHashB32) % C.LIMITER_SHARDS}`
}
