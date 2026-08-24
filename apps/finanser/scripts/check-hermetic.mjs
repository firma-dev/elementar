/**
 * Гейт герметичности (ТЗ §5, Д-012). Обещание «ни один байт не уходит с
 * устройства» проверяется не рассуждением, а грепом по собранному бандлу:
 * если в ассетах появилось чужое происхождение — сборка красная.
 *
 * Запуск: node scripts/check-hermetic.mjs [dist]
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const DIST = process.argv[2] ?? 'dist'

/**
 * Пространства имён XML (`http://www.w3.org/…`) — единственное исключение.
 * Это идентификаторы для `createElementNS`, а не адреса: preact передаёт их в
 * DOM, браузер по ним никуда не ходит и ходить не может. Исключение задано
 * префиксом www.w3.org, а не списком: preact добавляет новые пространства
 * (SVG, XHTML, MathML) между версиями, и список пришлось бы догонять.
 */
const NAMESPACE = 'http://www.w3.org/'

const ORIGIN = /(?:https?|wss?|ftp):\/\/[^\s"'`)\\]+/g
const SCAN = /\.(?:html|js|css|webmanifest|json)$/

/**
 * Протокольно-относительный адрес: `//cdn.example/f.css` в строке или в
 * `url(...)`. Схемы у него нет, поэтому под ORIGIN он не попадал, а браузер по
 * нему ходит так же охотно. Ищем только внутри кавычек и `url(`, иначе каждый
 * комментарий `//` в исходнике станет нарушением.
 */
const PROTOCOL_RELATIVE = /["'`(]\/\/[a-z0-9-]+\.[a-z]{2,}/gi

/**
 * Сетевые вызовы как таковые. Прежний гейт смотрел только на вид строки, и
 * мимо него спокойно проходило `fetch('/api/collect')` или
 * `navigator.sendBeacon('/stat', body)`: адрес свой, происхождение то же, а
 * байты ушли. Для приложения, которое обещает «ни одного внешнего запроса»,
 * проверять надо не адреса, а само наличие запроса.
 *
 * Здесь нет исключений по адресу намеренно: в коде корпуса сетевого вызова не
 * должно быть вообще никакого.
 */
const NETWORK = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bsendBeacon\s*\(/,
  /\bnew\s+WebSocket\b/,
  /\bnew\s+EventSource\b/,
]

// Регистрация собственного воркера в список не входит: `sw.js` берётся с того
// же адреса, что и страница, и без него нет офлайна. Это условие работы, а не
// утечка — из устройства при этом не уходит ничего.

/**
 * Сервис-воркер — единственный файл, которому `fetch` положен по устройству:
 * он и есть обработчик `fetch`, и без него офлайн не работает. Всё остальное
 * запрещено и ему: маячок из воркера уходит так же незаметно.
 *
 * Чужие адреса в нём проверяются наравне со всеми — ORIGIN на него смотрит.
 */
const WORKER = /(?:^|[\\/])sw\.js$/
const WORKER_ALLOWED = /\bfetch\s*\(/

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

const problems = []
for (const file of await walk(DIST)) {
  // Карты исходников в раздачу не идут и внешних адресов не создают.
  if (file.endsWith('.map') || !SCAN.test(file)) continue
  const text = await readFile(file, 'utf8')
  const name = relative(DIST, file)

  for (const match of text.match(ORIGIN) ?? []) {
    const origin = match.replace(/[.,;:]+$/, '')
    if (origin.startsWith(NAMESPACE)) continue
    problems.push(`${name}: чужое происхождение ${origin}`)
  }

  for (const match of text.match(PROTOCOL_RELATIVE) ?? []) {
    problems.push(`${name}: адрес без схемы ${match.slice(1)}`)
  }

  if (!file.endsWith('.css') && !file.endsWith('.webmanifest')) {
    const isWorker = WORKER.test(file)
    for (const pattern of NETWORK) {
      if (!pattern.test(text)) continue
      if (isWorker && WORKER_ALLOWED.source === pattern.source) continue
      const found = pattern.exec(text)?.[0] ?? String(pattern)
      problems.push(`${name}: сетевой вызов ${found.trim()}`)
    }
  }
}

if (problems.length > 0) {
  console.error('Герметичность нарушена:')
  for (const line of [...new Set(problems)]) console.error('  ' + line)
  process.exit(1)
}
console.log('Герметично: ни чужих адресов, ни сетевых вызовов в бандле нет.')
