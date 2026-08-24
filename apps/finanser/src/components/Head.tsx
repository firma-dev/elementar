import type { JSX } from 'preact'
import type { Kopeck } from '../money.js'
import { formatShare } from '../money.js'
import { Amount } from './Amount.js'

export interface HeadProps {
  /** Подпись отрезка: «за месяц», «за год». */
  title: string
  spent: Kopeck
  income: Kopeck
  /** Предел трат на отрезок. `null` — плана нет или отрезок длинный. */
  limit: Kopeck | null
  /** Сколько частей отрезка прожито из скольких: 24 дня из 31. */
  elapsed: { done: number; total: number }
  /** Средняя трата и средний приход за месяц — для длинных отрезков. */
  average: { spend: Kopeck; income: Kopeck } | null
  /** Отложено за календарный месяц и сколько ещё до цели. */
  saving: { done: Kopeck; left: Kopeck; goal: Kopeck } | null
  onSetPlan: () => void
}

/**
 * Шапка картины: потрачено и пришло.
 *
 * Одна на все шесть отрезков — и это в ней главное. Раньше на коротких
 * отрезках стояла полоса предела, на длинных две плитки, и переключение
 * периода сдвигало всё, что ниже, на сто с лишним пикселей: человек нажимал
 * кнопку, а экран уезжал из-под пальца. Скелет теперь один, меняется
 * наполнение — высота остаётся.
 *
 * По той же причине место под полосу и под нижнюю строку держится всегда,
 * даже когда сказать нечего: строка то в одну, то в две — тот же прыжок,
 * только поменьше.
 */
export function Head({
  title,
  spent,
  income,
  limit,
  elapsed,
  average,
  saving,
  onSetPlan,
}: HeadProps): JSX.Element {
  const over = limit !== null && spent > limit
  const fill = limit === null || limit === 0 ? 0 : Math.min(100, Math.round((spent / limit) * 100))
  const pace = Math.min(100, Math.round((elapsed.done / elapsed.total) * 100))

  return (
    <div class="f-head2">
      <div class="f-head2__cell f-head2__cell--main">
        <span class="f-head2__k">Потрачено {title}</span>
        <Amount
          class={over ? 'f-head2__v f-head2__v--over' : 'f-head2__v'}
          value={spent}
          kopecks="never"
        />

        {/* Дорожка занимает место всегда, но рисуется только когда есть с чем
            сравнивать: всегда пустая шкала читалась бы как «ноль процентов
            чего-то», то есть сообщала бы неправду. */}
        <span class={limit === null ? 'f-head2__track f-head2__track--none' : 'f-head2__track'}>
          {limit === null ? null : (
            <>
              <span
                class={over ? 'f-head2__fill f-head2__fill--over' : 'f-head2__fill'}
                style={`width:${fill}%`}
              />
              {elapsed.total > 1 ? <span class="f-head2__pace" style={`left:${pace}%`} /> : null}
            </>
          )}
        </span>

        <span class="f-head2__sub">
          {limit !== null ? (
            <>
              из <Amount value={limit} kopecks="never" />
              {' · '}
              {over ? (
                <span class="f-head2__over">
                  сверх плана на <Amount value={(spent - limit) as Kopeck} kopecks="never" />
                </span>
              ) : (
                <span class="f-head2__left">
                  осталось <Amount value={(limit - spent) as Kopeck} kopecks="never" />
                </span>
              )}
            </>
          ) : average !== null ? (
            <>
              в среднем <Amount value={average.spend} kopecks="never" /> в месяц
            </>
          ) : (
            /* Коротко: длинная фраза занимала третью строку, и шапка от неё
               росла — то есть возвращался тот самый прыжок. */
            <>
              не с чем сравнить —{' '}
              <button type="button" class="f-linkish" onClick={onSetPlan}>
                задать план →
              </button>
            </>
          )}
        </span>
      </div>

      <div class="f-head2__cell">
        <span class="f-head2__k">Пришло {title}</span>
        <Amount class="f-head2__v f-head2__v--in" value={income} kopecks="never" />
        <span class="f-head2__track" />
        <span class="f-head2__sub">
          {saving !== null ? (
            <>
              отложено <Amount value={saving.done} kopecks="never" />
              {saving.goal === 0 ? null : saving.left === 0 ? (
                ' · цель месяца взята'
              ) : (
                <>
                  {' · до цели '}
                  <Amount value={saving.left} kopecks="never" />
                </>
              )}
            </>
          ) : average !== null ? (
            <>
              в среднем <Amount value={average.income} kopecks="never" /> в месяц
            </>
          ) : income > 0 ? (
            <>{formatShare(spent, income)}% поступлений ушло на траты</>
          ) : null}
        </span>
      </div>
    </div>
  )
}
