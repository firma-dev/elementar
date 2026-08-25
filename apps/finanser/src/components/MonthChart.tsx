import type { JSX } from 'preact'
import type { MonthTotals } from '../stats.js'
import { monthLabel, monthShort } from '../model.js'
import { Amount } from './Amount.js'

export interface MonthChartProps {
  months: readonly MonthTotals[]
  selected: string | null
  hovered: string | null
  onSelect: (month: string | null) => void
  onHover: (month: string | null) => void
}

/**
 * Траты по месяцам. Столбики — элементы потока, а не SVG: график тянется по
 * ширине телефона и остаётся нажимаемым.
 *
 * Цвет столбика говорит о состоянии и взят из прототипа: выбранный — чернилами,
 * наведённый — акцентом, остальные — серым. Красный на наведении не украшение:
 * он показывает, какой столбик сейчас читается в строке над графиком.
 */
export function MonthChart({
  months,
  selected,
  hovered,
  onSelect,
  onHover,
}: MonthChartProps): JSX.Element {
  const max = months.reduce((m, row) => Math.max(m, row.spend), 1)
  const peekKey = hovered ?? selected ?? months[months.length - 1]?.month ?? null
  const peek = months.find((m) => m.month === peekKey)

  /**
   * Цвет столбика. Обычный берётся из смыслового токена, а не из палитры:
   * палитра при смене темы не переворачивается, и `gray-700` оставался одним и
   * тем же серым и на белой бумаге, и на чёрной. Тот же токен стоит базовым у
   * `.f-chart__bar`, поэтому дневной и месячный графики выглядят одинаково.
   */
  const barColor = (active: boolean, hover: boolean): string =>
    active ? 'var(--el__text)' : hover ? 'var(--el__data-negative)' : 'var(--el__data-tertiary)'

  return (
    <section class="f-chart" onMouseLeave={() => onHover(null)}>
      <div class="f-chart__head">
        <h2 class="f-eyebrow">По месяцам</h2>
        {peek === undefined ? null : (
          <div class="f-chart__peek">
            <span class="f-chart__peekname">{monthLabel(peek.month)}</span>
            <span>
              −<Amount value={peek.spend} kopecks="never" abs />
            </span>
            <span class="f-chart__in">
              +<Amount value={peek.income} kopecks="never" abs />
            </span>
          </div>
        )}
      </div>

      <div class="f-chart__bars" role="group" aria-label="Траты по месяцам">
        {months.map((row) => {
          const active = selected === row.month
          const hover = hovered === row.month
          const height = Math.max(2, Math.round((1000 * row.spend) / max) / 10)
          return (
            <button
              key={row.month}
              type="button"
              class="f-chart__col"
              aria-pressed={active}
              aria-label={monthLabel(row.month)}
              onMouseEnter={() => onHover(row.month)}
              onFocus={() => onHover(row.month)}
              onClick={() => onSelect(active ? null : row.month)}
            >
              <span class="f-chart__slot">
                <span
                  class="f-chart__bar"
                  style={`height:${height}%;background:${barColor(active, hover)}`}
                />
              </span>
            </button>
          )
        })}
      </div>

      <div class="f-chart__labels" aria-hidden="true">
        {months.map((row) => {
          const active = selected === row.month
          const hover = hovered === row.month
          const cls = active
            ? 'f-chart__tick f-chart__tick--on'
            : hover
              ? 'f-chart__tick f-chart__tick--hover'
              : 'f-chart__tick'
          return (
            <span key={row.month} class={cls}>
              {monthShort(row.month)}
            </span>
          )
        })}
      </div>
    </section>
  )
}
