import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Kopeck } from '../money.js'
import { parseAmount } from '../money.js'
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
  /** Назвать остаток рукой: банк выгружает его не всегда. */
  onSet: (kopecks: Kopeck) => void
  /** Назван ли остаток рукой — от этого зависит, что писать в подписи. */
  byHand: boolean
  /** День, на который назван остаток: с него он и пересчитывается. */
  namedAt: string
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
  onSet,
  byHand,
  namedAt,
}: BalanceProps): JSX.Element | null {
  const [asking, setAsking] = useState(false)
  if (onAccount === null && next === null) return null
  const room = dailyRoom(onAccount, next?.date ?? null, edge, owedToSavings)

  return (
    <dl class="f-bal">
      <div class="f-bal__cell">
        <dt class="f-bal__k">на счёте</dt>
        <dd class="f-bal__v">
          {/* Остаток банк кладёт в выгрузку не всегда, а посчитать его из
              операций нельзя: выписка начинается не с нуля, и их сумма — это
              движение за период, а не остаток. Значит, спрашиваем. Одно число
              рукой — не то же, что вести траты руками: его называют раз в
              месяц, и без него не считается главное, «сколько можно тратить». */}
          {asking ? (
            <form
              class="f-ask"
              onSubmit={(event) => {
                event.preventDefault()
                const field = (event.currentTarget as HTMLFormElement).elements.namedItem(
                  'сумма',
                ) as HTMLInputElement
                const value = parseAmount(field.value)
                if (value !== null) onSet(Math.abs(value) as Kopeck)
                setAsking(false)
              }}
            >
              <label class="f-ask__k" for="остаток-сумма">
                Сколько сейчас на счёте — посмотрите в банке
              </label>
              <input
                id="остаток-сумма"
                name="сумма"
                type="text"
                inputMode="decimal"
                autoFocus
                aria-label="Остаток на счёте"
              />
              <button type="submit" class="f-btn">
                запомнить
              </button>
              <button type="button" class="f-btn" onClick={() => setAsking(false)}>
                отмена
              </button>
            </form>
          ) : onAccount === null ? (
            <button type="button" class="f-btn" onClick={() => setAsking(true)}>
              указать остаток
            </button>
          ) : (
            <>
              <Amount class="f-bal__num f-bal__num--in" value={onAccount} kopecks="never" />
              {byHand ? (
                <button
                  type="button"
                  class="f-bal__edit"
                  title="Остаток назван рукой — банк его не выгрузил. Дальше считается сам: операции после этого дня прибавляются и вычитаются"
                  onClick={() => setAsking(true)}
                >
                  с ваших слов на {dayLabel(namedAt)} · изменить
                </button>
              ) : null}
            </>
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
                : 'укажите остаток слева — и посчитаем'}
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
