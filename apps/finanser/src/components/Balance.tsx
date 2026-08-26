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
 * Два числа, за которыми возвращаются каждый день: сколько на счёте и сколько
 * можно тратить.
 *
 * Ровно два, а не три. Ближайший приход стоял отдельной ячейкой с датой
 * крупным числом — но дата ничего не решает, её и так знают; решает то,
 * сколько денег в день она оставляет. Дата и сумма прихода переехали в
 * подпись, где им место как обстоятельству, а ряд стал двухколоночным, как
 * все остальные ряды страницы.
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

      {/* Ближайший приход и то, что можно тратить, — одна ячейка.

          Датой было набрано главное число: «5 сентября» крупно, а сколько на
          неё жить — мелко строкой ниже, в соседней ячейке. Но дата сама по
          себе ничего не решает, её и так знают; решает то, сколько денег в
          день она оставляет. Числа поменялись местами: крупным — рубли в день,
          дата ушла в подпись, где ей и место как обстоятельству.

          Недоотложенное вычитается: копилка — обязательство наравне с арендой,
          а не «остаток на потом». Не вычесть её значит разрешить потратить одни
          и те же деньги дважды. */}
      <div class="f-bal__cell">
        <dt class="f-bal__k">можно тратить</dt>
        <dd class="f-bal__v">
          {room === null ? (
            <span class="f-bal__none">
              {next === null
                ? 'регулярных источников не видно'
                : 'банк не выгрузил остаток — не от чего считать'}
            </span>
          ) : room.perDay === 0 ? (
            <span class="f-bal__none">
              свободных денег нет: остаток меньше того, что осталось отложить
            </span>
          ) : (
            <>
              <Amount class="f-bal__num" value={room.perDay} kopecks="never" />
              <span class="f-bal__note">
                в день · {room.days}{' '}
                {room.days % 10 === 1 && room.days % 100 !== 11 ? 'день' : 'дн.'} до{' '}
                {next === null ? (
                  'прихода'
                ) : (
                  <>
                    {dayLabel(next.date)}, <Amount value={next.amount} kopecks="never" />
                  </>
                )}
              </span>
            </>
          )}
        </dd>
      </div>

    </dl>
  )
}
