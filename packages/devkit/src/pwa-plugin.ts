import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import { renderSwTemplate } from './sw-template.ts'
import type { PrecacheEntry } from './sw-template.ts'

export interface PwaPluginOptions {
  /** Версия сборки: попадает в имя кэша и в PwaState.version. */
  version?: string
  /** Имя файла воркера в корне scope. */
  swFileName?: string
  /** Документ навигации (cache-first, §13.3). */
  navigateFallback?: string
  /** Что класть в precache. Путь — от корня scope, со слешем. */
  precache?: (path: string) => boolean
  /** Адреса синка для connect-src. Домены живут в @elementar/proto, сюда приходят снаружи. */
  connectSrc?: readonly string[]
  /** Писать `_headers` для Cloudflare Pages. */
  headers?: boolean
}

const DEFAULT_PRECACHE = /(?:\.html|\.js|\.css|\.woff2|\.webmanifest)$|^\/i\/.*\.(?:png|svg)$/

/** Файлы, которые не имеет смысла или нельзя класть в precache. */
const NEVER_PRECACHE = /(?:\.map$|^\/sw\.js$|^\/_headers$)/

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function sha256Base64(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('base64')
}

async function walk(dir: string, root: string, out: string[]): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, root, out)
    else out.push('/' + relative(root, full).split(sep).join('/'))
  }
  return out
}

/** sha256 всех инлайн-скриптов страницы: ровно они и разрешаются в CSP (§13.4). */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = []
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    const body = m[1]
    if (body === undefined || body.trim() === '') continue
    out.push(`'sha256-${sha256Base64(body)}'`)
  }
  return out
}

export function buildCsp(scriptHashes: readonly string[], connectSrc: readonly string[]): string {
  const connect = ["'self'", ...connectSrc].join(' ')
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    // инлайн-стили нужны компонентам (transform у свайпа); скриптов это не касается
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "require-trusted-types-for 'script'",
  ].join('; ')
}

export function headersFile(csp: string): string {
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Resource-Policy: same-origin',
    '  Permissions-Policy: geolocation=(), camera=(), microphone=(), interest-cohort=()',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/sw.js',
    '  Cache-Control: no-cache',
    '',
    '/index.html',
    '  Cache-Control: no-cache',
    '',
  ].join('\n')
}

/**
 * Плагин PWA: собирает precache-манифест с хешами, рендерит воркер из шаблона
 * и выписывает CSP с хешем инлайн-скрипта темы. `unsafe-inline` для скриптов не вводится.
 */
export function elementarPwa(options: PwaPluginOptions = {}): Plugin {
  const swFileName = options.swFileName ?? 'sw.js'
  const navigateFallback = options.navigateFallback ?? '/index.html'
  const version = options.version ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  let config: ResolvedConfig

  return {
    name: 'elementar:pwa',
    apply: 'build',
    configResolved(resolved): void {
      config = resolved
    },
    config() {
      return { define: { __ELM_VERSION__: JSON.stringify(version) } }
    },
    async closeBundle(): Promise<void> {
      const outDir = join(config.root, config.build.outDir)
      const files = (await walk(outDir, outDir, [])).sort()

      const keep = options.precache ?? ((p: string): boolean => DEFAULT_PRECACHE.test(p))
      const precache: PrecacheEntry[] = []
      for (const path of files) {
        if (NEVER_PRECACHE.test(path) || !keep(path)) continue
        precache.push({ u: path, h: sha256Hex(await readFile(join(outDir, path.slice(1)))) })
      }

      // Имя кэша обязано меняться вместе с содержимым, а не со временем сборки:
      // при версии-таймстампе две сборки в одну минуту делят кэш и воркер отдаёт
      // старые ассеты. Считаем идентификатор из самого precache-манифеста.
      const buildId = sha256Hex(
        Buffer.from(precache.map((e) => e.u + ':' + e.h).join('\n'), 'utf8'),
      ).slice(0, 16)

      await writeFile(
        join(outDir, swFileName),
        renderSwTemplate({ version: `${version}-${buildId}`, precache, navigate: navigateFallback }),
        'utf8',
      )

      if (options.headers === false) return
      const htmlPath = join(outDir, navigateFallback.replace(/^\//, ''))
      const html = await readFile(htmlPath, 'utf8').catch(() => '')
      const csp = buildCsp(inlineScriptHashes(html), options.connectSrc ?? [])
      await writeFile(join(outDir, '_headers'), headersFile(csp), 'utf8')
    },
  }
}
