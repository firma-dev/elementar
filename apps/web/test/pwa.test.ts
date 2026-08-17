import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCsp, inlineScriptHashes } from '@elementar/devkit/pwa-plugin'
import { renderSwTemplate } from '@elementar/devkit/sw-template'
import { THEME_INLINE_SCRIPT } from '../src/theme-inline.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8')) as Record<
  string,
  unknown
>

describe('index.html и CSP', () => {
  it('инлайн-скрипт ровно один и совпадает с theme-inline.ts', () => {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (m) => m[1] ?? '',
    )
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toBe(THEME_INLINE_SCRIPT)
  })

  it('хеш инлайн-скрипта попадает в script-src, unsafe-inline не вводится', () => {
    const hashes = inlineScriptHashes(html)
    const expected = `'sha256-${createHash('sha256').update(THEME_INLINE_SCRIPT, 'utf8').digest('base64')}'`
    expect(hashes).toEqual([expected])
    const csp = buildCsp(hashes, ['https://s.elementar.example'])
    expect(csp).toContain(`script-src 'self' ${expected}`)
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false)
    expect(csp).toContain("require-trusted-types-for 'script'")
  })

  it('viewport и theme-color на месте (§13.2)', () => {
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('interactive-widget=resizes-content')
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain('/i/app-180.png')
  })
})

describe('манифест', () => {
  it('один scope и один id (§13.1)', () => {
    expect(manifest['scope']).toBe('/')
    expect(manifest['id']).toBe('/')
    expect(manifest['start_url']).toBe('/')
    expect(manifest['display']).toBe('standalone')
  })

  it('иконки и ярлыки', () => {
    const icons = manifest['icons'] as Array<{ src: string; purpose?: string }>
    expect(icons.map((i) => i.src)).toContain('/i/app-512.png')
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true)
    const shortcuts = manifest['shortcuts'] as Array<{ url: string }>
    expect(shortcuts.map((s) => s.url)).toEqual(['/p/last?new=1', '/p/last?view=today'])
  })
})

describe('шаблон сервис-воркера', () => {
  const sw = renderSwTemplate({
    version: '1.2.3',
    precache: [{ u: '/index.html', h: 'ab'.repeat(32) }],
    navigate: '/index.html',
  })

  it('плейсхолдеры подставлены', () => {
    expect(sw).toContain("const VERSION = '1.2.3'")
    expect(sw).toContain('"u":"/index.html"')
    expect(sw).not.toContain('__PRECACHE__')
    expect(sw).not.toContain('__VERSION__')
    expect(sw).not.toContain('__NAVIGATE__')
  })

  it('навигация cache-first, /v1 не кэшируется, skipWaiting только по сообщению', () => {
    expect(sw).toContain("if (request.mode === 'navigate')")
    expect(sw).toContain('cacheFirst(request, NAVIGATE)')
    expect(sw).toContain("url.pathname.startsWith('/v1/')")
    expect(sw).toContain("event.data === 'SKIP_WAITING'")
    expect(sw).not.toContain('self.skipWaiting()\n  event') // не в install
  })

  it('установка проверяет sha256 каждого ассета', () => {
    expect(sw).toContain('хеш не совпал')
    expect(sw).toContain("crypto.subtle.digest('SHA-256'")
  })
})
