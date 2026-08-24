import type { JSX } from 'preact'
import type { Summary } from '../insights.js'
import { dayLabel } from '../model.js'
import { Amount } from './Amount.js'

/** Шаг регулярного платежа словами. */
function cadence(days: number): string {
  if (days <= 9) return 'каждую неделю'
  if (days <= 45) return 'каждый месяц'
  if (days <= 120) return 'раз в квартал'
  if (days <= 220) return 'раз в полгода'
  return 'раз в год'
}

/**
 * Счётная сводка (ТЗ §2 п.5). Считается арифметикой на странице по нажатию —
 * ни модели, ни сети. Каждая строка называет числа, из которых получена: вывод,
 * который нельзя проверить глазами, здесь не произносится.
 *
 * В прототипе дизайн-сессии этого экрана нет; он оставлен, потому что входит в
 * объём v0 по ТЗ, и переодет в тот же язык — рамки, капс, без заливок.
 */
export function SummaryView({ summary }: { summary: Summary }): JSX.Element {
  const stopped = summary.subscriptions.filter((s) => s.stopped)
  const active = summary.subscriptions.filter((s) => !s.stopped)

  return (
    <div class="f-summary">
      {summary.insights.length === 0 ? (
        <p class="f-note">
          Данных пока мало: для сравнения месяцев нужна выписка хотя бы за два месяца.
        </p>
      ) : (
        <ul role="list">
          {summary.insights.map((insight, index) => (
            <li key={`${insight.kind}-${index}`} class="f-card" data-tone={insight.tone}>
              <h3 class="f-card__title">{insight.title}</h3>
              <p class="f-card__body">{insight.detail}</p>
            </li>
          ))}
        </ul>
      )}

      {active.length > 0 ? (
        <div class="f-subs">
          <h3 class="f-eyebrow f-subs__title">Регулярные платежи</h3>
          <p class="f-note">
            Одинаковая сумма одному получателю с ровным шагом. Финансер видит платежи, а не то, чем
            вы пользуетесь, — решать, нужен ли платёж, вам.
          </p>
          <ul role="list">
            {active.map((sub) => (
              <li key={`${sub.merchant}-${sub.amount}`} class="f-sub">
                <span class="f-sub__name">{sub.merchant}</span>
                <span class="f-sub__meta">
                  {cadence(sub.everyDays)}, {sub.count} раз с {dayLabel(sub.first)}
                </span>
                <Amount class="f-sub__sum" value={sub.amount} abs />
                <span class="f-sub__year">
                  <Amount value={sub.perYear} kopecks="never" abs /> в год
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {stopped.length > 0 ? (
        <div class="f-subs">
          <h3 class="f-eyebrow f-subs__title">Платежи, которые прекратились</h3>
          <p class="f-note">
            Шли ровно и перестали. Это может быть отменённая подписка, а может — сбой оплаты, о
            котором вы не знаете.
          </p>
          <ul role="list">
            {stopped.map((sub) => (
              <li key={`${sub.merchant}-${sub.amount}`} class="f-sub f-sub--off">
                <span class="f-sub__name">{sub.merchant}</span>
                <span class="f-sub__meta">
                  последний раз {dayLabel(sub.last)}, тишина {sub.silentDays} дн.
                </span>
                <Amount class="f-sub__sum" value={sub.amount} abs />
                <span class="f-sub__year" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
