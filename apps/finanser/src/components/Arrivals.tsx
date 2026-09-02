import type { JSX } from 'preact'
import type { IncomeSource } from '../income.js'
import type { Kopeck } from '../money.js'
import { dayLabel } from '../model.js'
import { Amount } from './Amount.js'

export interface ArrivalsProps {
  sources: readonly IncomeSource[]
  /** Ближайший ожидаемый приход — по регулярным источникам. */
  next: { date: string; label: string; amount: Kopeck } | null
}

/** Сколько источников показываем. Больше трёх — это уже список, а не ответ. */
const SHOWN = 3

/** «3 раза», «11 раз», «1 раз» — иначе в строке стояло «3 РАЗ». */
function times(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return `${n} раз`
  if (ones === 1) return `${n} раз`
  if (ones >= 2 && ones <= 4) return `${n} раза`
  return `${n} раз`
}

/**
 * Откуда и когда приходят деньги.
 *
 * Сверху — когда ждать следующий приход, ниже — от кого деньги приходят
 * вообще. Регулярные первыми: на них живут, остальное случается.
 *
 * Три строки, а не двадцать: полный список стоит за дверью «подробно». На
 * сводке он отвечал бы на вопрос, которого никто не задаёт каждый день, — «а
 * кто прислал мне тысячу в апреле».
 *
 * Всё выровнено по одной сетке — и строка ожидания, и строки источников: имя
 * слева, приписка и сумма справа по общей вертикали. Раньше строка ожидания
 * шла сплошняком, «25 СЕНТЯБРЯ 73 494 ЗАРПЛАТА АВАНС КАПИТАЛ ГРУП», и читать
 * её приходилось по слогам.
 */
export function Arrivals({ sources, next }: ArrivalsProps): JSX.Element | null {
  // Ожидание показывается и без источников за отрезок: в начале месяца
  // приходов ещё нет, а вопрос «когда придут» как раз тогда и задают.
  if (sources.length === 0 && next === null) return null
  const top = [...sources]
    .sort((a, b) => Number(b.regular) - Number(a.regular) || b.total - a.total)
    .slice(0, SHOWN)

  return (
    <div class="f-arr">
      {next === null ? null : (
        <p class="f-arr__row f-arr__row--next">
          <span class="f-arr__who">{next.label}</span>
          <span class="f-arr__mark">ждём {dayLabel(next.date)}</span>
          <Amount class="f-arr__sum" value={next.amount} kopecks="never" />
        </p>
      )}

      <ul class="f-arr__list" role="list">
        {top.map((source) => (
          <li key={source.key} class="f-arr__row">
            <span class="f-arr__who">{source.label}</span>
            <span class="f-arr__mark">{source.regular ? 'каждый месяц' : times(source.count)}</span>
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
