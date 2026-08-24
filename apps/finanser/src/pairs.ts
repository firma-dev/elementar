/**
 * Переводы между своими счетами.
 *
 * Перевод с дебетовой на кредитную виден дважды: минусом на одной выписке и
 * плюсом на другой. В годовой сумме трат это не врёт — обе стороны считаются
 * переездом денег, а не тратой (Д-015), — но в «Движениях денег» одна и та же
 * тысяча показана дважды, и человек читает её как две.
 *
 * Пара опознаётся по трём признакам разом: одинаковая сумма с разными знаками,
 * разные счета, близкие даты. Ни один из них по отдельности не годится:
 * одинаковых сумм в выписке много, а разные счета бывают у любых двух операций.
 *
 * Осторожность здесь дороже полноты. Ложная пара прячет настоящий приход и
 * настоящую трату — то есть уносит деньги из картины; пропущенная пара всего
 * лишь оставляет строку, которая и так была. Поэтому: только точное совпадение
 * суммы, только разные счета, только два дня разницы, и каждая операция
 * участвует ровно в одной паре.
 */
import type { Categorized } from './model.js'
import { planeOfTx } from './plane.js'
import { operationOf } from './operation.js'

/** Насколько далеко друг от друга могут стоять две стороны одного перевода. */
const MAX_DAYS = 2

export interface Pair {
  out: Categorized
  in: Categorized
}

/**
 * Похожа ли операция на приходную сторону своего же перевода.
 *
 * Плана «переезд» здесь мало: приходную сторону банк обычно пишет как
 * «Пополнение» без имени отправителя, она попадает в приход и раздувает
 * «Поступления». Это и есть та поломка, которую пара чинит, — значит, по
 * плану её не отобрать. Отбираем по виду операции, который банк назвал сам.
 */
function looksIncoming(tx: Categorized): boolean {
  if (planeOfTx(tx.category, tx.amount) === 'move') return true
  const kind = operationOf(tx.description).kind
  return kind === 'topup' || kind === 'transfer' || kind === 'cash'
}

function days(a: string, b: string): number {
  const diff = new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()
  return Math.abs(Math.round(diff / 86400000))
}

/**
 * Найти пары. Возвращает только уверенные — см. рассуждение выше.
 */
export function findPairs(rows: readonly Categorized[]): Pair[] {
  const outs = rows.filter((tx) => tx.amount < 0 && planeOfTx(tx.category, tx.amount) === 'move')
  const ins = rows.filter((tx) => tx.amount > 0 && looksIncoming(tx))

  const taken = new Set<string>()
  const pairs: Pair[] = []
  for (const out of outs) {
    const match = ins.find(
      (candidate) =>
        !taken.has(candidate.id) &&
        candidate.amount === -out.amount &&
        candidate.account !== out.account &&
        days(candidate.date, out.date) <= MAX_DAYS,
    )
    if (match === undefined) continue
    taken.add(match.id)
    taken.add(out.id)
    pairs.push({ out, in: match })
  }
  return pairs
}

/**
 * Идентификаторы приходных сторон найденных пар.
 *
 * Помечается именно приходная: расходная несёт описание получателя («Перевод
 * на счёт кредитной»), а приходная обычно безымянна («Пополнение»).
 */
export function pairedIncoming(pairs: readonly Pair[]): Set<string> {
  return new Set(pairs.map((pair) => pair.in.id))
}

/**
 * Пометить приходные стороны переводов переводами.
 *
 * Не выбросить, а перевести в план «переезд». Выбросить нельзя: выписка должна
 * показывать то, что сказал банк, иначе человек не найдёт операцию, которую
 * видит в приложении банка. А вот считать её приходом — неправда: эта тысяча
 * уже была на другом счёте, и в «Поступлениях» она удваивала настоящий доход.
 */
export function markPairs(rows: readonly Categorized[]): Categorized[] {
  const paired = pairedIncoming(findPairs(rows))
  if (paired.size === 0) return rows as Categorized[]
  return rows.map((tx) =>
    paired.has(tx.id) ? { ...tx, category: 'Переводы' as const, source: 'operation' as const } : tx,
  )
}
