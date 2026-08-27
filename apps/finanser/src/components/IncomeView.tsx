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
  const max = sources.reduce((m, s) => Math.max(m, s.total), 1)

  // Тот же порядок цветов, что у категорий трат: главный источник выделен,
  // остальные тускнеют. Зелёный вместо красного — единственная разница.
  const fill = (i: number): string =>
    i === 0
      ? 'var(--el__success)'
      : i < 3
        ? 'var(--el__color-gray-700)'
        : 'var(--el__color-gray-500)'

  // Раскрыт сразу — как «Траты по категориям» напротив. Источники прихода это
  // и есть содержимое блока доходов: под свёрткой блок состоял из числа,
  // графика и приглашения нажать, тогда как расходы напротив сразу показывали,
  // куда всё ушло. Разбор был спрятан ровно с той стороны, где его труднее
  // восстановить по памяти: свои траты человек примерно помнит, а список
  // поступлений за год — нет.
  return (
    <Fold title="Откуда приходит" meta={`${sources.length} ${word(sources.length)}`} startOpen>
      <p class="f-note">
        За всё загруженное, а не за выбранный отрезок: одним днём о том, откуда приходят деньги, не
        судят.{' '}
        {regular.length === 0
          ? 'Регулярных источников пока не видно: все приходы разовые или история слишком короткая.'
          : `${regular.length} из ${sources.length} приходят регулярно и дают ${formatShare(regularSum as Kopeck, total)}% всех поступлений.`}
      </p>

      <ul class="f-inc" role="list">
        {sources.map((source, i) => (
          <li key={source.key} class="f-inc__row">
            {/* Строка собрана ровно как строка категории напротив: номер, имя,
                доля, сумма, дорожка. Раньше слева был аккуратный список с
                долями и полосами, справа — имя и сумма враспор: два списка об
                одном и том же, набранные разным языком. */}
            <div class="f-inc__line">
              <span class="f-inc__left">
                <span class="f-inc__rank">{i + 1}</span>
                <span class="f-inc__name">{source.label}</span>
                <span class="f-inc__share">{formatShare(source.total, total)}%</span>
              </span>
              <Amount class="f-inc__sum" value={source.total} kopecks="never" />
            </div>
            <span class="f-inc__track">
              <span
                class="f-inc__fill"
                style={`display:block;width:${Math.max(1, Math.round((100 * source.total) / max))}%;background:${fill(i)}`}
              />
            </span>
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
              {/* «Последний» вернулось: без него дата вставала вплотную к
                  сумме, и «обычно 11 804 28 июля» читалось как одно число с
                  хвостом. Разделять точками мало — тут рядом стоят две вещи
                  одного рода, число и число. */}
              <span class="f-inc__last">последний {dayLabel(source.lastDate)}</span>
              {/* Убрать — тихой ссылкой у правого края. Прижата к краю, а не
                  дописана следом за датой: длина подписи источника разная, и
                  ссылка вставала то тут, то там — глаз искал её заново в
                  каждой строке. */}
              <span class="f-inc__act">
                <Confirm
                  label="не доход"
                  question={`убрать «${source.label}» из доходов?`}
                  confirm="да, убрать"
                  onConfirm={() => onExclude(source.ids)}
                />
              </span>
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
