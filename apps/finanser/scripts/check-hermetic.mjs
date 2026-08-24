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
  for (const match of text.match(ORIGIN) ?? []) {
    const origin = match.replace(/[.,;:]+$/, '')
    if (origin.startsWith(NAMESPACE)) continue
    problems.push(`${relative(DIST, file)}: ${origin}`)
  }
}

if (problems.length > 0) {
  console.error('Герметичность нарушена — в бандле есть чужие адреса:')
  for (const line of [...new Set(problems)]) console.error('  ' + line)
  process.exit(1)
}
console.log('Герметично: внешних адресов в бандле нет.')
