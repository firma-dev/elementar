import type { JSX } from 'preact'
import type { Kopeck } from '../money.js'
import { dayLabel } from '../model.js'
import { Amount } from './Amount.js'

export interface BalanceProps {
  /** Остаток по счетам, если банк его выгрузил. */
  onAccount: Kopeck | null
  /** Ближайший ожидаемый приход — только по регулярным источникам. */
  next: { date: string; label: string; amount: Kopeck } | null
}

/**
 * Два числа, за которыми возвращаются каждый день: сколько есть и когда придёт
 * ещё.
 *
 * Копилки здесь нет намеренно. Она стояла третьим числом, а ниже на том же
 * экране лежит блок «Копилка» с той же суммой — один смысл в двух местах, и
 * человеку приходится решать, какое из них главное. Сумма осталась там, где у
 * неё есть контекст: цель, срок и то, как шли месяцы.
 *
 * Числа, которых нет, не подменяются нулями. Ноль на счёте и «банк не сказал,
 * сколько на счёте» — разные новости, а выглядели бы одинаково.
 */
export function Balance({ onAccount, next }: BalanceProps): JSX.Element | null {
  if (onAccount === null && next === null) return null

  return (
    <dl class="f-bal">
      <div class="f-bal__cell">
        <dt class="f-bal__k">на счёте</dt>
        <dd class="f-bal__v">
          {onAccount === null ? (
            <span class="f-bal__none">банк не выгрузил остаток</span>
          ) : (
            <Amount class="f-bal__num f-bal__num--in" value={onAccount} kopecks="never" />
          )}
        </dd>
      </div>

      <div class="f-bal__cell">
        <dt class="f-bal__k">ближайший приход</dt>
        <dd class="f-bal__v">
          {next === null ? (
            <span class="f-bal__none">регулярных источников не видно</span>
          ) : (
            <>
              <span class="f-bal__num">{dayLabel(next.date)}</span>
              <span class="f-bal__note">
                {next.label} · <Amount value={next.amount} kopecks="never" />
              </span>
            </>
          )}
        </dd>
      </div>

    </dl>
  )
}
