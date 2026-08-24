import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import { dayLabel } from '../model.js'
import type { Kopeck } from '../money.js'
import { regularMonthly, regularSpends } from '../income.js'
import { Amount } from './Amount.js'
import { Fold } from './Fold.js'

export interface RegularProps {
  rows: readonly Categorized[]
  /** Край данных: по нему судят, сколько раз платёж мог прийти, но не пришёл. */
  edge: string
}

/**
 * Что уходит само.
 *
 * Подписки, аренда, связь, рассрочки — деньги, которые списываются без участия
 * человека и потому не замечаются. Список из ста получателей бесполезен; список
 * из девяти регулярных — это разговор, и обычно он начинается словами «а это
 * что такое, я же отменил».
 *
 * Регулярность считается по данным, а не спрашивается, и тем же кодом, что у
 * доходов: платёж, приходивший почти каждый месяц с тех пор, как появился, —
 * регулярный.
 *
 * Смотрит на всё загруженное, а не на выбранный отрезок: за один день
 * регулярности не бывает.
 */
export function Regular({ rows, edge }: RegularProps): JSX.Element | null {
  const list = regularSpends(rows, edge)
  if (list.length === 0) return null
  const monthly = regularMonthly(list)

  return (
    <Fold title="Уходит само" meta={`${list.length} ${word(list.length)}`}>
      <p class="f-note">
        Списывается без вашего участия и потому не замечается. За месяц это{' '}
        <Amount value={monthly} kopecks="never" />, за год —{' '}
        <Amount value={(monthly * 12) as Kopeck} kopecks="never" />. Считано по всему загруженному:
        за один день регулярности не бывает.
      </p>

      <ul class="f-inc" role="list">
        {list.map((source) => (
          <li key={source.key} class="f-inc__row">
            <div class="f-inc__line">
              <span class="f-inc__name">{source.label}</span>
              <Amount class="f-inc__sum" value={source.typical} kopecks="never" />
            </div>
            <div class="f-inc__meta">
              <span class="f-inc__kind">в месяц</span>
              <span class="f-inc__typical">
                всего <Amount value={source.total} kopecks="never" /> за {source.months} мес.
              </span>
              <span class="f-inc__last">последний — {dayLabel(source.lastDate)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Fold>
  )
}

/** Склонение для «платёж / платежа / платежей». */
function word(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return 'платежей'
  if (ones === 1) return 'платёж'
  if (ones >= 2 && ones <= 4) return 'платежа'
  return 'платежей'
}
