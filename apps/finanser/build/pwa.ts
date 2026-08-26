import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * Сервис-воркер финансера. Свой, а не из `@elementar/devkit`, по одной причине:
 * тамошний кладёт в precache абсолютные пути от корня сайта, а финансер должен
 * работать и по адресу `/финансер/` (ТЗ §5). Здесь все пути относительные и
 * разрешаются от scope самого воркера.
 *
 * Кэш-фёрст: страница уже на устройстве, и сеть её не ускорит, а на плохой
 * мобильной связи — задержит. Ассеты именованы по хешу, поэтому конфликта версий
 * внутри одного кэша быть не может.
 */
// `.svg` в списке с 26 августа: знак в шапке лежит отдельным файлом, и без
// него офлайн открывался бы корпус без опознавательного знака — пустое место
// там, где имя. Иконки приложения (`i/*.png`) уже здесь по той же причине.
const PRECACHE = /(?:\.html|\.js|\.css|\.woff2|\.svg|\.webmanifest)$|^i\/.*\.png$/
const NEVER = /(?:\.map$|^sw\.js$|^_headers$)/

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function walk(dir: string, root: string, out: string[]): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, root, out)
    else out.push(relative(root, full).split(sep).join('/'))
  }
  return out
}

function renderSw(version: string, files: readonly string[]): string {
  return `// Сгенерировано сборкой финансера. Правится в apps/finanser/build/pwa.ts.
const VERSION = ${JSON.stringify(version)}
const CACHE = 'finanser-' + VERSION
const FILES = ${JSON.stringify(files)}

const url = (path) => new URL(path, self.registration.scope).toString()

// Ни skipWaiting, ни захвата уже открытых вкладок. Это не осторожность, а
// исправление гонки: старая вкладка держит старый index.html, в котором стоят
// имена ассетов со старым хешем. Если новый воркер активируется под ней и снесёт
// прежний кэш, эти ассеты исчезнут — статик-хостинг ответит на них страницей
// (SPA-фолбэк, 200 text/html), модуль не загрузится, и человек увидит белый
// экран. Новая версия встаёт при следующем холодном запуске, когда старых
// вкладок не осталось; ровно тогда же безопасно чистить кэш (§13.6: молчаливой
// подмены под руками нет).
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map(url))))
})

// Обновление ставится по нажатию человека, а не само (§13.6). Пока он не
// нажал, новый воркер ждёт; страница под ним продолжает работать на старых
// ассетах, и белого экрана из-за снесённого кэша не бывает.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  // Чужое происхождение воркер не трогает вообще: у финансера его и нет,
  // но правило записано явно, чтобы оно не появилось незаметно.
  if (new URL(request.url).origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(url('index.html')).then((hit) => hit || fetch(request)),
    )
    return
  }
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)))
})
`
}

export function finanserPwa(options: { version: string }): Plugin {
  let config: ResolvedConfig
  return {
    name: 'finanser:pwa',
    apply: 'build',
    configResolved(resolved): void {
      config = resolved
    },
    async closeBundle(): Promise<void> {
      const outDir = join(config.root, config.build.outDir)
      const files = (await walk(outDir, outDir, []))
        .filter((p) => !NEVER.test(p) && PRECACHE.test(p))
        .sort()

      const parts: string[] = []
      for (const path of files) parts.push(`${path}:${sha256(await readFile(join(outDir, path)))}`)
      // Идентификатор считается из содержимого, а не из времени сборки: две
      // сборки в одну минуту иначе делят кэш и воркер отдаёт старые ассеты.
      const buildId = sha256(parts.join('\n')).slice(0, 16)

      await writeFile(join(outDir, 'sw.js'), renderSw(`${options.version}-${buildId}`, files), 'utf8')
    },
  }
}

/**
 * Снятие неиспользуемых начертаний. Финансер набран одним шрифтом (Д-014), но
 * `@font-face` для Basis Grotesque Pro приезжает из `@elementar/ui/styles.css` —
 * файла общего с планером, который финансеру править нельзя.
 *
 * Оставить их как есть нельзя тоже: в них абсолютные пути `/fonts/basis-*`,
 * которых в сборке финансера больше нет. Мёртвое правило с абсолютным путём
 * ломает обещание «работает по любому префиксу» — стоит браузеру решить, что
 * начертание нужно, и он пойдёт в корень чужого сайта.
 *
 * Снимается на выходе, а не на входе: `@import` дизайн-системы разворачивает
 * сам vite, и до этого разворота правил в исходнике ещё нет. Плата за это —
 * предупреждение сборки о неразрешённых путях; оно гасится в `vite.config.ts`
 * и там же объяснено, почему оно ложное.
 */
export function dropUnusedFonts(family: string): Plugin {
  const block = new RegExp(
    String.raw`@font-face\s*\{[^}]*font-family:\s*["']?${family}["']?[^}]*\}`,
    'gi',
  )
  return {
    name: 'finanser:drop-unused-fonts',
    apply: 'build',
    generateBundle(_options, bundle): void {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue
        const css =
          typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8')
        file.source = css.replace(block, '')
      }
    },
  }
}
