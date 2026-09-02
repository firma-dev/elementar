import type { JSX } from 'preact'
import type { IncomeSource } from '../income.js'
import type { Kopeck } from '../money.js'
import { dayLabel } from '../model.js'
import { Amount } from './Amount.js'

export interface ArrivalsProps {
  sources: readonly IncomeSource[]
  /** Ближайший ожидаемый приход — по регулярным источникам. */
  next: { date: string; label: string; amount: Kopeck } | null
  edge: string
}

/** Сколько источников показываем. Больше трёх — это уже список, а не ответ. */
const SHOWN = 3

/**
 * Откуда и когда приходят деньги.
 *
 * Два вопроса, один ответ: сверху — когда ждать следующий приход, ниже — от
 * кого деньги приходят вообще. Регулярные первыми: на них живут, остальное
 * случается.
 *
 * Три строки, а не двадцать. Полный список стоит за дверью «подробно» вместе с
 * разбором: на главном экране он отвечал бы на вопрос, которого никто не
 * задаёт каждый день, — «а кто прислал мне тысячу в апреле».
 */
export function Arrivals({ sources, next, edge }: ArrivalsProps): JSX.Element | null {
  if (sources.length === 0) return null
  const top = [...sources]
    .sort((a, b) => Number(b.regular) - Number(a.regular) || b.total - a.total)
    .slice(0, SHOWN)

  return (
    <div class="f-arr">
      {next === null ? null : (
        <p class="f-arr__next">
          <span class="f-arr__when">{dayLabel(next.date)}</span>
          <Amount class="f-arr__sum" value={next.amount} kopecks="never" />
          <span class="f-arr__who">{next.label}</span>
        </p>
      )}

      <ul class="f-arr__list" role="list">
        {top.map((source) => (
          <li key={source.key} class="f-arr__row">
            <span class="f-arr__who">{source.label}</span>
            <span class="f-arr__mark">{source.regular ? `${source.count} раз` : 'разово'}</span>
            <Amount class="f-arr__sum" value={source.total} kopecks="never" />
          </li>
        ))}
      </ul>

      {sources.length > SHOWN ? (
        <p class="f-arr__more">ещё {sources.length - SHOWN} · в «подробно»</p>
      ) : null}
    </div>
  )
}
