import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import type { Kopeck } from '../money.js'
import { planeOfTx } from '../plane.js'
import { shiftDays } from '../period.js'
import { Amount } from './Amount.js'

export interface DayChartProps {
  rows: readonly Categorized[]
  from: string
  to: string
  /** Дневной предел: по нему день красится в «сверх нормы». */
  limit: Kopeck | null
  selected: string | null
  onSelect: (date: string | null) => void
}

/** Траты по дням отрезка. Дни без трат остаются в ряду пустыми местами. */
export function daySpend(
  rows: readonly Categorized[],
  from: string,
  to: string,
): Array<{ date: string; spend: Kopeck }> {
  const sums = new Map<string, number>()
  for (const tx of rows) {
    if (tx.date < from || tx.date > to) continue
    if (planeOfTx(tx.category, tx.amount) !== 'spend') continue
    if (tx.amount >= 0) continue
    sums.set(tx.date, (sums.get(tx.date) ?? 0) - tx.amount)
  }
  const out: Array<{ date: string; spend: Kopeck }> = []
  for (let date = from; date <= to; date = shiftDays(date, 1)) {
    out.push({ date, spend: (sums.get(date) ?? 0) as Kopeck })
  }
  return out
}

/**
 * Столбики по дням.
 *
 * Пустые дни рисуются пустыми, а не выбрасываются: ряд из четырнадцати дней с
 * тремя пропусками — это другая картина, чем одиннадцать дней подряд, и
 * выбросить пропуски значило бы её подменить.
 *
 * День сверх дневной нормы красный. Это единственный цвет на графике: если
 * красить всё, красное перестаёт значить.
 */
export function DayChart({
  rows,
  from,
  to,
  limit,
  selected,
  onSelect,
}: DayChartProps): JSX.Element | null {
  const days = daySpend(rows, from, to)
  if (days.length < 2) return null
  const max = Math.max(...days.map((d) => d.spend), 1)

  return (
    <div class="f-days">
      <div class="f-days__bars">
        {days.map((day) => {
          const height = Math.round((day.spend / max) * 100)
          const over = limit !== null && day.spend > limit
          const on = selected === day.date
          return (
            <button
              key={day.date}
              type="button"
              class="f-days__col"
              aria-pressed={on}
              title={`${day.date.slice(8, 10)}.${day.date.slice(5, 7)}`}
              onClick={() => onSelect(on ? null : day.date)}
            >
              <span class="f-days__slot">
                <span
                  class={
                    on
                      ? 'f-days__bar f-days__bar--on'
                      : over
                        ? 'f-days__bar f-days__bar--over'
                        : 'f-days__bar'
                  }
                  style={`height:${Math.max(day.spend === 0 ? 0 : 2, height)}%`}
                />
              </span>
            </button>
          )
        })}
      </div>
      <div class="f-days__scale">
        <span class="f-days__tick">{Number(from.slice(8, 10))}</span>
        <span class="f-days__peak">
          самый дорогой день — <Amount value={max as Kopeck} kopecks="never" />
        </span>
        <span class="f-days__tick">{Number(to.slice(8, 10))}</span>
      </div>
    </div>
  )
}
