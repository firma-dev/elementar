/**
 * План.
 *
 * Человек вводит три числа: сколько рассчитывает получить, сколько уходит на
 * обязательное и сколько откладывать. Четвёртое — «на жизнь» — не спрашивается,
 * потому что уже известно: это остаток от первых трёх (Д-026). Просить его
 * значило бы позволить сумме не сойтись.
 *
 * Пределы на день и на неделю тоже считаются, а не вводятся: месячный предел,
 * делённый на дни этого месяца. В феврале дневной предел выше, чем в январе, и
 * это правда, а не округление.
 */
import type { Kopeck } from './money.js'
import { daysInMonth, isDaily } from './period.js'
import type { PeriodKey } from './period.js'

export interface Plan {
  /** Сколько человек рассчитывает получить за месяц. */
  income: Kopeck
  /** Обязательные платежи: аренда, кредит, всё, что не обсуждается. */
  fixed: Kopeck
  /** Сколько откладывать за месяц. */
  save: Kopeck
  /**
   * Сколько всего лежит в копилке. Из выписки это не узнать — накопительный
   * счёт человек обычно не выгружает, — поэтому вводится рукой.
   */
  saved: Kopeck
}

export const EMPTY_PLAN: Plan = { income: 0, fixed: 0, save: 0, saved: 0 }

/** Заполнен ли план хоть на что-то. Пустой не показывается: пустая шкала врёт. */
export function hasPlan(plan: Plan): boolean {
  return plan.income > 0 || plan.fixed > 0 || plan.save > 0
}

/**
 * На жизнь — то, что остаётся после обязательного и откладываемого.
 *
 * Может выйти отрицательным: значит, план не сходится, и об этом надо сказать,
 * а не подтянуть до нуля. Подтянутый до нуля план выглядит выполнимым.
 */
export function living(plan: Plan): Kopeck {
  return (plan.income - plan.fixed - plan.save) as Kopeck
}

/**
 * Предел трат на период.
 *
 * Для длинных периодов предела нет: план месячный, а за прошедший год он
 * наверняка был другим. Умножить сегодняшний план на двенадцать и выдать это
 * за годовую норму — врать с точностью до копейки.
 */
export function limitFor(key: PeriodKey, edge: string, plan: Plan): Kopeck | null {
  if (!hasPlan(plan) || !isDaily(key)) return null
  const month = living(plan)
  if (month <= 0) return null
  switch (key) {
    case 'month':
      return month
    case 'week':
      return Math.round((month / daysInMonth(edge)) * 7) as Kopeck
    default:
      return Math.round(month / daysInMonth(edge)) as Kopeck
  }
}

/**
 * Сколько осталось отложить до месячной цели.
 *
 * Сравнивается именно отложенное за этот месяц, а не всё накопленное: цель
 * месячная, и копилка в сто тысяч не отменяет того, что в августе не отложено
 * ничего. Ноль — цель взята.
 */
export function toGoal(plan: Plan, setAside: Kopeck): Kopeck {
  return Math.max(0, plan.save - setAside) as Kopeck
}
