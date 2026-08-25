/**
 * Разбор быстрой записи: «кофе 250» → трата 250 ₽ с описанием «кофе».
 *
 * Одно поле вместо формы. Форма из четырёх полей — сумма, описание, категория,
 * дата — это четыре решения перед каждой записанной чашкой кофе, и ради неё
 * приложение не открывают. Здесь решение одно: что и сколько. Остальное
 * достаётся само и остаётся видимым, чтобы поправить.
 *
 * Разбор нарочно снисходительный: «250 кофе», «кофе 250 р», «кофе 250,50» —
 * всё это одно и то же. Человек не должен помнить порядок слов.
 */
import type { Category } from './model.js'
import type { Kopeck } from './money.js'
import { parseAmount } from './money.js'
import { byRules } from './categorize.js'

export interface Quick {
  amount: Kopeck
  description: string
  /** Догадка по словарю правил. `null` — не угадали, будет «Прочее». */
  category: Category | null
  /** Приход, а не трата: строка начиналась с «+». */
  income: boolean
}

/**
 * Число в строке: последовательность цифр с необязательной дробной частью.
 *
 * Берётся последнее подходящее, а не первое: в «такси до Внуково 1200» число
 * рейса или адреса стоит раньше суммы куда чаще, чем наоборот.
 */
const NUMBER = /(?<![\d,.])\d[\d  ]*(?:[.,]\d{1,2})?(?![\d])/g

export function parseQuick(input: string): Quick | null {
  const raw = input.trim()
  if (raw === '') return null

  // Ведущий «+» — приход. Снимается до поиска числа, иначе попадёт в описание.
  const income = raw.startsWith('+')
  const body = income ? raw.slice(1).trim() : raw

  const matches = [...body.matchAll(NUMBER)]
  const last = matches[matches.length - 1]
  if (last === undefined) return null

  const kopecks = parseAmount(last[0])
  if (kopecks === null || kopecks === 0) return null

  // Описание — всё, кроме самой суммы. Хвост вроде «р», «руб», «₽» убирается:
  // он сказан про сумму, а не про то, на что потрачено.
  const description = (body.slice(0, last.index) + ' ' + body.slice(last.index + last[0].length))
    .replace(/\s*(?:₽|руб(?:\.|ля|лей)?|р\.?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (description === '') return null

  return {
    amount: (income ? Math.abs(kopecks) : -Math.abs(kopecks)) as Kopeck,
    description,
    category: byRules(description),
    income,
  }
}
