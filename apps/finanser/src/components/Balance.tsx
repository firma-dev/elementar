import type { JSX } from 'preact'
import type { Kopeck } from '../money.js'
import { dayLabel } from '../model.js'
import { dailyRoom } from '../savings.js'
import { Amount } from './Amount.js'

export interface BalanceProps {
  /** Остаток по счетам, если банк его выгрузил. */
  onAccount: Kopeck | null
  /** Ближайший ожидаемый приход — только по регулярным источникам. */
  next: { date: string; label: string; amount: Kopeck } | null
  /** Край данных: от него считаются дни до прихода. */
  edge: string
  /** Сколько ещё предстоит отложить по плану в этом месяце. */
  owedToSavings: Kopeck
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
export function Balance({
  onAccount,
  next,
  edge,
  owedToSavings,
}: BalanceProps): JSX.Element | null {
  if (onAccount === null && next === null) return null
  const room = dailyRoom(onAccount, next?.date ?? null, edge, owedToSavings)

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

      {/* Связка. Остаток и дата зарплаты порознь не говорят ничего: «на счёте
          73 840» — это много или мало? Ответ зависит от того, сколько дней
          терпеть и сколько из этих денег уже обещано копилке.

          Недоотложенное вычитается: копилка — обязательство наравне с арендой,
          а не «остаток на потом». Не вычесть её значит разрешить потратить одни
          и те же деньги дважды. */}
      {room === null ? null : (
        <div class="f-bal__cell">
          <dt class="f-bal__k">до прихода можно</dt>
          <dd class="f-bal__v">
            {room.perDay === 0 ? (
              <span class="f-bal__none">
                свободных денег нет: остаток меньше того, что осталось отложить
              </span>
            ) : (
              <>
                <Amount class="f-bal__num" value={room.perDay} kopecks="never" />
                <span class="f-bal__note">
                  в день, дней {room.days} · <Amount value={room.free} kopecks="never" /> свободно
                </span>
              </>
            )}
          </dd>
        </div>
      )}
    </dl>
  )
}
