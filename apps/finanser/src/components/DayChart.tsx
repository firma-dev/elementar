import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import type { Kopeck } from '../money.js'
import { planeOfTx } from '../plane.js'
import { shiftDays } from '../period.js'
import { dayLabel } from '../model.js'
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
 *
 * На отрезке «день» рисуется не один столбик, а вся его неделя с подсветкой
 * выбранного дня. Во-первых, один столбик ничего не сообщает: сравнивать не с
 * чем. Во-вторых, график тогда исчезал бы совсем — и переключение отрезка
 * сдвигало бы всё, что ниже, ровно там, где человек нажимает.
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
  if (days.length === 0) return null
  const max = Math.max(...days.map((d) => d.spend), 1)
  const shown = days.find((d) => d.date === selected) ?? days[days.length - 1]

  return (
    <div class="f-chart">
      {/* Та же раскладка, что у графика по месяцам: подпись, ряд столбиков,
          ряд делений. Одинаковая высота у обоих — не аккуратность ради
          аккуратности: разная сдвигала всё, что ниже, при смене отрезка. */}
      <div class="f-chart__head">
        <span class="f-eyebrow">По дням</span>
        <span class="f-chart__peek">
          <span class="f-chart__peekname">{shown === undefined ? '' : dayLabel(shown.date)}</span>
          <Amount value={-(shown?.spend ?? 0)} kopecks="never" />
        </span>
      </div>

      <div class="f-chart__bars">
        {days.map((day) => {
          const height = Math.round((day.spend / max) * 100)
          const over = limit !== null && day.spend > limit
          const on = selected === day.date
          return (
            <button
              key={day.date}
              type="button"
              class="f-chart__col"
              aria-pressed={on}
              title={`${dayLabel(day.date)}`}
              onClick={() => onSelect(on ? null : day.date)}
            >
              <span class="f-chart__slot">
                <span
                  class={
                    on
                      ? 'f-chart__bar f-chart__bar--on'
                      : over
                        ? 'f-chart__bar f-chart__bar--over'
                        : 'f-chart__bar'
                  }
                  style={`height:${Math.max(day.spend === 0 ? 0 : 2, height)}%`}
                />
              </span>
            </button>
          )
        })}
      </div>

      <div class="f-chart__labels">
        {days.map((day) => (
          <span
            key={day.date}
            class={selected === day.date ? 'f-chart__tick f-chart__tick--on' : 'f-chart__tick'}
          >
            {/* Каждое пятое число и края: подписать все тридцать один день
                нечем — цифры сливаются в серую полосу. */}
            {label(day.date, days.length)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Подпись деления: число месяца у краёв и каждого пятого дня, иначе пусто. */
function label(date: string, total: number): string {
  const day = Number(date.slice(8, 10))
  if (total <= 8) return String(day)
  return day % 5 === 0 || day === 1 ? String(day) : ''
}
