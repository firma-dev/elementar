import type { JSX } from 'preact'
import type { Kopeck } from '../money.js'
import { Amount } from './Amount.js'

export interface LimitProps {
  spent: Kopeck
  /** Предел на этот период. `null` — плана нет или период длинный. */
  limit: Kopeck | null
  /** Сколько частей периода прожито из скольких: 24 дня из 31. */
  elapsed: { done: number; total: number }
  label: string
  /** Открыть план. Без плана предела нет, и звать надо отсюда. */
  onSetPlan: () => void
}

/**
 * Потрачено за период и сколько это относительно плана.
 *
 * Полоса показывает две вещи разом: сколько истрачено и сколько периода
 * прожито. Без второй мерки «75 928 из 80 000» ничего не значит — двадцать
 * четвёртого числа это норма, пятого числа это тревога. Засечка прожитого и
 * отвечает на вопрос «я иду с опережением или отстаю».
 *
 * Плана нет — нет и полосы. Пустая шкала выглядит как шкала, у которой всё
 * хорошо.
 */
export function Limit({ spent, limit, elapsed, label, onSetPlan }: LimitProps): JSX.Element {
  const over = limit !== null && spent > limit
  const fill = limit === null || limit === 0 ? 0 : Math.min(100, Math.round((spent / limit) * 100))
  const pace = Math.min(100, Math.round((elapsed.done / elapsed.total) * 100))

  return (
    <div class="f-limit">
      <span class="f-limit__k">{label}</span>
      <Amount
        class={over ? 'f-limit__v f-limit__v--over' : 'f-limit__v'}
        value={spent}
        kopecks="never"
      />

      {limit === null ? (
        /* Звать к плану надо отсюда: без него предела нет, а мёртвая фраза
           «плана нет» оставляла бы человека гадать, где он заводится. */
        <span class="f-limit__sub">
          сколько это — непонятно, пока нет плана.{' '}
          <button type="button" class="f-linkish" onClick={onSetPlan}>
            задать план →
          </button>
        </span>
      ) : (
        <>
          <span class="f-limit__track">
            <span
              class={over ? 'f-limit__fill f-limit__fill--over' : 'f-limit__fill'}
              style={`width:${fill}%`}
            />
            {/* Засечка прожитого: слева от неё — идём с опережением. */}
            {elapsed.total > 1 ? (
              <span class="f-limit__pace" style={`left:${pace}%`} aria-hidden="true" />
            ) : null}
          </span>
          <span class="f-limit__sub">
            из <Amount value={limit} kopecks="never" />
            {' · '}
            {over ? (
              <span class="f-limit__over">
                сверх плана на <Amount value={(spent - limit) as Kopeck} kopecks="never" />
              </span>
            ) : (
              <span class="f-limit__left">
                осталось <Amount value={(limit - spent) as Kopeck} kopecks="never" />
              </span>
            )}
          </span>
        </>
      )}
    </div>
  )
}
