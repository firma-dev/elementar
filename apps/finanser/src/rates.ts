/**
 * Курсы валют.
 *
 * Банк пересчитывает не всё: часть операций приезжает в евро или лирах без
 * рублёвой суммы. Раньше они молча считались рублями, и приложение честно об
 * этом предупреждало — но предупреждение не превращает неправду в правду:
 * тысяча лир и тысяча рублей продолжали складываться в одну сумму.
 *
 * Курс не выясняется сам: любой источник курса — это внешний запрос, а корпус
 * герметичен (ТЗ §1). Значит, курс называет человек. Одно число на валюту,
 * и оно сохраняется — курс на день покупки он всё равно не помнит, а средний
 * за период даёт цифру, которой можно верить.
 */
import type { Categorized, Tx } from './model.js'
import type { Kopeck } from './money.js'

/** Курсы: код валюты → сколько копеек за одну единицу. */
export type Rates = Readonly<Record<string, number>>

/** Валюты, встреченные в выписке, и сколько операций в каждой. */
export function foreignCurrencies(rows: readonly Tx[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const tx of rows) {
    const code = tx.currency
    if (code === null || code === undefined || code === '') continue
    out.set(code, (out.get(code) ?? 0) + 1)
  }
  return out
}

/**
 * Пересчитать по названным курсам.
 *
 * Операции в валютах, для которых курса нет, остаются как были — то есть
 * по-прежнему посчитаны рублями, и предупреждение про них тоже остаётся.
 * Пересчитать наполовину и промолчать было бы хуже, чем не пересчитать вовсе.
 */
export function applyRates(rows: readonly Categorized[], rates: Rates): Categorized[] {
  const codes = Object.keys(rates)
  if (codes.length === 0) return rows as Categorized[]
  return rows.map((tx) => {
    const code = tx.currency
    if (code === null || code === undefined) return tx
    const rate = rates[code]
    if (rate === undefined || rate <= 0) return tx
    return {
      ...tx,
      amount: Math.round((tx.amount * rate) / 100) as Kopeck,
      currency: null,
      description: `${tx.description} · ${code}`,
    }
  })
}

/** Сколько операций всё ещё посчитаны рублями, хотя рублями не были. */
export function stillForeign(rows: readonly Tx[], rates: Rates): number {
  let n = 0
  for (const tx of rows) {
    const code = tx.currency
    if (code === null || code === undefined || code === '') continue
    const rate = rates[code]
    if (rate === undefined || rate <= 0) n += 1
  }
  return n
}
