/**
 * Шаблон сервис-воркера (§13.3). Пишется руками; на сборке `pwa-plugin` подставляет
 * `__VERSION__`, `__PRECACHE__` (список файлов с их sha256) и `__NAVIGATE__`.
 *
 * Правила, которые нельзя нарушать:
 *  - ответы `/v1/*`, кросс-ориджин и не-GET никогда не попадают в Cache Storage;
 *  - навигация — cache-first из precache, без network-first с таймаутом;
 *  - установка отменяется, если sha256 любого precache-ассета не совпал с манифестом;
 *  - skipWaiting только по сообщению 'SKIP_WAITING' — молчаливого обновления нет (§13.6).
 */

export const PLACEHOLDER = {
  version: '__VERSION__',
  precache: '__PRECACHE__',
  navigate: '__NAVIGATE__',
} as const

/** Один элемент precache-манифеста: путь и его sha256 в hex. */
export interface PrecacheEntry {
  u: string
  h: string
}

export interface SwTemplateValues {
  version: string
  precache: readonly PrecacheEntry[]
  /** Документ, который отдаётся на любую навигацию. */
  navigate: string
}

export const SW_TEMPLATE = String.raw`/* Элементар — сервис-воркер оболочки. Сгенерирован из packages/devkit/src/sw-template.ts. */
'use strict'

const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const NAVIGATE = '__NAVIGATE__'
const CACHE = 'elm-shell-' + VERSION

const IMMUTABLE = /\/assets\//
const REVALIDATE = /\.(?:png|svg|ico|webp|woff2?|webmanifest)$/

function toHex(buffer) {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(buffer) {
  return toHex(await crypto.subtle.digest('SHA-256', buffer))
}

/** Скачать и проверить один ассет. Несовпадение хеша — отказ от установки (§13.5 п.3). */
async function fetchVerified(entry) {
  const res = await fetch(entry.u, { cache: 'reload', credentials: 'same-origin' })
  if (!res.ok) throw new Error('precache: ' + entry.u + ' → ' + res.status)
  const body = await res.clone().arrayBuffer()
  const got = await sha256Hex(body)
  if (got !== entry.h) throw new Error('precache: хеш не совпал для ' + entry.u)
  return res
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // последовательно: параллельная загрузка десятка файлов на 3G мешает первой отрисовке
      for (const entry of PRECACHE) {
        const res = await fetchVerified(entry)
        await cache.put(entry.u, res)
      }
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.map((n) => (n === CACHE ? undefined : caches.delete(n))))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting()
  }
})

async function cacheFirst(request, key) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(key === undefined ? request : key)
  if (hit !== undefined) return hit
  try {
    const res = await fetch(request)
    if (res.ok && request.method === 'GET') await cache.put(key === undefined ? request : key, res.clone())
    return res
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' })
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  const network = fetch(request)
    .then((res) => {
      if (res.ok) void cache.put(request, res.clone())
      return res
    })
    .catch(() => undefined)
  if (hit !== undefined) return hit
  const res = await network
  return res === undefined ? new Response('', { status: 504, statusText: 'Offline' }) : res
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  // данные пользователя не кэшируются никогда: SW про оболочку
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return

  if (request.mode === 'navigate') {
    event.respondWith(cacheFirst(request, NAVIGATE))
    return
  }
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(request))
    return
  }
  if (REVALIDATE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request))
    return
  }
  event.respondWith(
    fetch(request).catch(() => new Response('', { status: 504, statusText: 'Offline' })),
  )
})
`

/** Подставить значения в шаблон. Порядок замен не важен: плейсхолдеры не пересекаются. */
export function renderSwTemplate(values: SwTemplateValues): string {
  return SW_TEMPLATE.split(PLACEHOLDER.version)
    .join(values.version)
    .split(`'${PLACEHOLDER.precache}'`)
    .join(JSON.stringify(values.precache))
    .split(PLACEHOLDER.precache)
    .join(JSON.stringify(values.precache))
    .split(PLACEHOLDER.navigate)
    .join(values.navigate)
}
