import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import type { Kopeck } from '../money.js'
import { formatShare } from '../money.js'
import { INCOME_KIND_LABEL, byIncomeSource } from '../income.js'
import { dayLabel } from '../model.js'
import { Amount } from './Amount.js'
import { Fold } from './Fold.js'
import { Confirm } from './Confirm.js'

export interface IncomeViewProps {
  rows: readonly Categorized[]
  /** Край данных: по нему судят, сколько раз источник мог прийти. */
  edge: string
  total: Kopeck
  /**
   * Убрать источник из доходов: его операции перестают считаться приходом.
   *
   * Банк называет переводом от человека и зарплату, и возврат долга, и деньги,
   * переложенные с собственной карты в другом банке. Выписка их не различает, а
   * человек различает сразу — значит, решение за ним, и оно должно быть здесь,
   * рядом со строкой, а не в списке из шестисот операций.
   */
  onExclude: (ids: readonly string[]) => void
}

/**
 * Откуда приходят деньги.
 *
 * Годовая сумма поступлений молчит о главном: пять источников по сорок тысяч
 * и один на двести — разные жизни. Здесь про каждый сказано три вещи: сколько,
 * как приходит и регулярно ли.
 *
 * Регулярность считается по данным, а не спрашивается. Если истории меньше
 * трёх месяцев, так и написано: судить не по чему. Написать «разовый» вместо
 * этого значило бы выдать незнание за факт.
 *
 * Раздел смотрит на все загруженные операции, а не на выбранный отрезок, и
 * говорит об этом вслух. Иначе он исчезал бы на «дне» — за один день приходов
 * обычно нет, — а вопрос «откуда у меня деньги» не про один день. Сумма за
 * выбранный отрезок отвечает на другой вопрос и стоит отдельно, в строке
 * «Пришло за …».
 */
export function IncomeView({ rows, edge, total, onExclude }: IncomeViewProps): JSX.Element | null {
  const sources = byIncomeSource(rows, edge)
  if (sources.length === 0) return null

  const regular = sources.filter((s) => s.regular)
  const regularSum = regular.reduce((sum, s) => sum + s.total, 0)

  return (
    <Fold title="Откуда приходит" meta={`${sources.length} ${word(sources.length)}`}>
      <p class="f-note">
        За всё загруженное, а не за выбранный отрезок: одним днём о том, откуда приходят деньги, не
        судят.{' '}
        {regular.length === 0
          ? 'Регулярных источников пока не видно: все приходы разовые или история слишком короткая.'
          : `${regular.length} из ${sources.length} приходят регулярно и дают ${formatShare(regularSum as Kopeck, total)}% всех поступлений.`}
      </p>

      <ul class="f-inc" role="list">
        {sources.map((source) => (
          <li key={source.key} class="f-inc__row">
            <div class="f-inc__line">
              <span class="f-inc__name">{source.label}</span>
              <Amount class="f-inc__sum" value={source.total} kopecks="never" />
            </div>
            <div class="f-inc__meta">
              <span class="f-inc__kind">{INCOME_KIND_LABEL[source.kind]}</span>
              <span
                class={source.regular ? 'f-inc__mark f-inc__mark--on' : 'f-inc__mark'}
                title={
                  source.judged
                    ? `Приходил в ${source.months} разных месяцах`
                    : 'Истории меньше трёх месяцев — судить не по чему'
                }
              >
                {source.judged ? (source.regular ? 'регулярно' : 'разово') : 'пока не видно'}
              </span>
              {source.count > 1 ? (
                <span class="f-inc__typical">
                  обычно <Amount value={source.typical} kopecks="never" />
                </span>
              ) : null}
              <span class="f-inc__last">последний — {dayLabel(source.lastDate)}</span>
              {/* Убрать — рядом со строкой, тихой ссылкой. Действие обратимое:
                  операции не удаляются, а перестают считаться приходом, и их
                  видно в «Движениях денег». */}
              <Confirm
                label="не доход"
                question={`убрать «${source.label}» из доходов?`}
                confirm="да, убрать"
                onConfirm={() => onExclude(source.ids)}
              />
            </div>
          </li>
        ))}
      </ul>
    </Fold>
  )
}

/** Склонение для «источник / источника / источников». */
function word(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return 'источников'
  if (ones === 1) return 'источник'
  if (ones >= 2 && ones <= 4) return 'источника'
  return 'источников'
}
