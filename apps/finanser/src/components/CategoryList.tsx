import type { JSX } from 'preact'
import type { CategoryTotals } from '../stats.js'
import type { Categorized, Category } from '../model.js'
import { dayLabel } from '../model.js'
import { merchantLabel } from '../merchant.js'
import { formatShare } from '../money.js'
import { Amount } from './Amount.js'

export interface CategoryListProps {
  rows: readonly CategoryTotals[]
  total: number
  /** Раскрытая категория: под её строкой видно, из чего она сложилась. */
  expanded: Category | null
  onToggle: (category: Category | null) => void
  /** Операции категории в текущем разрезе — год или выбранный месяц. */
  transactionsOf: (category: Category) => readonly Categorized[]
  onOpenAll: (category: Category) => void
}

/** Сколько трат показываем под раскрытой категорией, прежде чем звать в выписку. */
const PEEK = 8

/**
 * Траты по категориям. Порядок несёт смысл сам: у строки есть ранг, и первая
 * покрашена акцентом — это самая дорогая привычка периода.
 *
 * Нажатие раскрывает строку на месте, а не уводит на другой экран: вопрос
 * «из чего сложились эти сорок тысяч» задают, не отрываясь от картины, и ответ
 * должен появляться там же.
 */
export function CategoryList({
  rows,
  total,
  expanded,
  onToggle,
  transactionsOf,
  onOpenAll,
}: CategoryListProps): JSX.Element {
  const max = rows.reduce((m, row) => Math.max(m, row.spend), 1)

  /**
   * Цвет полосы — классом, а не строкой со значением цвета.
   *
   * Три цвета лежали здесь же, в логике, и два из них брались прямо из
   * палитры мимо слоя смыслов: на тёмной теме серый почти сливался с фоном, и
   * заметить это было негде — цвет не назывался больше нигде.
   */
  const fill = (i: number): string =>
    i === 0 ? 'f-cat__fill--top' : i < 3 ? 'f-cat__fill--high' : 'f-cat__fill--rest'

  return (
    <ul role="list">
      {rows.map((row, i) => {
        const open = expanded === row.category
        const inside = open ? transactionsOf(row.category) : []
        return (
          <li key={row.category}>
            <button
              type="button"
              class={open ? 'f-cat f-cat--open' : 'f-cat'}
              aria-expanded={open}
              onClick={() => onToggle(open ? null : row.category)}
            >
              <span class="f-cat__line">
                <span class="f-cat__left">
                  <span class="f-cat__rank">{i + 1}</span>
                  <span class="f-cat__name">{row.category}</span>
                  <span class="f-cat__share">{formatShare(row.spend, total)}%</span>
                </span>
                <Amount class="f-cat__sum" value={row.spend} kopecks="never" />
              </span>
              <span class="f-cat__track">
                <span
                  class={`f-cat__fill ${fill(i)}`}
                  style={`display:block;width:${Math.max(1, Math.round((100 * row.spend) / max))}%`}
                />
              </span>
            </button>

            {open ? (
              <div class="f-peek">
                {inside.slice(0, PEEK).map((tx) => (
                  <div key={tx.id} class="f-peek__row">
                    <span class="f-peek__day">{dayLabel(tx.date)}</span>
                    <span class="f-peek__name" title={tx.description}>
                      {merchantLabel(tx.description)}
                    </span>
                    <Amount class="f-peek__sum" value={tx.amount} abs />
                  </div>
                ))}
                <button
                  type="button"
                  class="f-linkish f-peek__all"
                  onClick={() => onOpenAll(row.category)}
                >
                  {inside.length > PEEK ? `все ${inside.length} операций →` : 'открыть в выписке →'}
                </button>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
