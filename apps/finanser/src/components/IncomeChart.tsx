import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import type { Kopeck } from '../money.js'
import type { MonthTotals } from '../stats.js'
import { planeOfTx } from '../plane.js'
import { shiftDays } from '../period.js'
import { dayLabel, monthLabel } from '../model.js'
import { Amount } from './Amount.js'

export interface IncomeChartProps {
  /** Операции по счёту — из них считается приход по дням. */
  rows: readonly Categorized[]
  /** Границы отрезка для дневного режима. */
  from: string
  to: string
  /** Готовые месячные итоги — для отрезков длиннее месяца. */
  months: readonly MonthTotals[]
  /** Короткий отрезок: рисовать по дням, а не по месяцам. */
  daily: boolean
}

/** Приход по дням отрезка. Дни без прихода остаются в ряду пустыми местами. */
export function dayIncome(
  rows: readonly Categorized[],
  from: string,
  to: string,
): Array<{ date: string; income: Kopeck }> {
  const sums = new Map<string, number>()
  for (const tx of rows) {
    if (tx.date < from || tx.date > to) continue
    if (planeOfTx(tx.category, tx.amount) !== 'income') continue
    if (tx.amount <= 0) continue
    sums.set(tx.date, (sums.get(tx.date) ?? 0) + tx.amount)
  }
  const out: Array<{ date: string; income: Kopeck }> = []
  for (let date = from; date <= to; date = shiftDays(date, 1)) {
    out.push({ date, income: (sums.get(date) ?? 0) as Kopeck })
  }
  return out
}

/**
 * Приход по дням или по месяцам.
 *
 * Зеркало расходного графика — и намеренно на его же классах: та же раскладка,
 * та же высота ряда, те же деления. Свой набор стилей выглядел бы «почти так
 * же», а почти — это ровно то, из-за чего экран кажется собранным из разных
 * мест. Одинаковая высота вдобавок держит на месте всё, что ниже: у расходов
 * график есть всегда, и если у прихода он то есть, то нет, правая колонка
 * прыгает относительно левой при каждой смене отрезка.
 *
 * Без графика доходы были единственной половиной картины без формы: сумма и
 * список источников, но не видно, ровно приход идёт или рывками. А рывками он
 * идёт у всех, кроме людей на окладе, и это первое, что стоит знать про свои
 * деньги.
 *
 * Столбик здесь не нажимается. У расходов нажатие ведёт к разбору категорий —
 * там есть куда вести; за днём или месяцем прихода стоит один-два источника, и
 * они уже перечислены строкой ниже. Кнопка, которая никуда не ведёт, хуже её
 * отсутствия.
 */
export function IncomeChart({
  rows,
  from,
  to,
  months,
  daily,
}: IncomeChartProps): JSX.Element | null {
  const bars: Array<{ key: string; value: Kopeck; full: string; tick: string }> = daily
    ? dayIncome(rows, from, to).map((d, _i, all) => ({
        key: d.date,
        value: d.income,
        full: dayLabel(d.date),
        tick: dayTick(d.date, all.length),
      }))
    : months.map((m) => ({
        key: m.month,
        value: m.income,
        full: monthLabel(m.month),
        // Без года: он один и тот же, повторять его двенадцать раз незачем.
        tick: monthLabel(m.month, true).split(' ')[0] ?? '',
      }))

  if (bars.length === 0) return null
  const top = Math.max(...bars.map((b) => b.value), 1)
  const best = bars.reduce((a, b) => (b.value > a.value ? b : a))

  return (
    <div class="f-chart f-chart--in">
      <div class="f-chart__head">
        <span class="f-eyebrow">{daily ? 'По дням' : 'По месяцам'}</span>
        <span class="f-chart__peek">
          {/* Показан самый крупный приход, а не последний: приход идёт редко,
              и последний день отрезка почти всегда нулевой — подпись
              сообщала бы «ноль» при полном графике. */}
          <span class="f-chart__peekname">{best.full}</span>
          <span class="f-chart__in">
            <Amount value={best.value} kopecks="never" />
          </span>
        </span>
      </div>

      <div class="f-chart__bars">
        {bars.map((bar) => (
          <span key={bar.key} class="f-chart__col" title={bar.full}>
            <span class="f-chart__slot">
              {/* День без прихода — пустое место, а не столбик в два пикселя.
                  У расходов такой обрубок серый и читается как пустой слот, а
                  здесь он зелёный: тридцать зелёных полосок по низу
                  складывались в сплошную линию, то есть в неправду — будто
                  деньги приходят каждый день. */}
              {bar.value === 0 ? null : (
                <span
                  class="f-chart__bar f-chart__bar--in"
                  style={`height:${Math.max(2, Math.round((bar.value / top) * 100))}%`}
                />
              )}
            </span>
          </span>
        ))}
      </div>

      <div class="f-chart__labels">
        {bars.map((bar) => (
          <span key={bar.key} class="f-chart__tick">
            {bar.tick}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Подпись деления в дневном режиме — та же, что у расходов: края и каждое пятое. */
function dayTick(date: string, total: number): string {
  const day = Number(date.slice(8, 10))
  if (total <= 8) return String(day)
  return day % 5 === 0 || day === 1 ? String(day) : ''
}
