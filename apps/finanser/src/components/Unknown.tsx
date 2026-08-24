import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { CATEGORIES, isCategory } from '../model.js'
import type { Categorized, Category } from '../model.js'
import { groupByMerchant } from '../merchant.js'
import { formatShare } from '../money.js'
import { Amount } from './Amount.js'

export interface UnknownProps {
  rows: readonly Categorized[]
  /** Трата за период — чтобы сказать, какую долю занимает неопознанное. */
  totalSpend: number
  /** Были ли в выписке MCC и категория банка. */
  hasCodes: boolean
  onMerchantCategory: (key: string, category: Category) => void
}

/** Сколько получателей показываем сразу. Дальше — по требованию. */
const PAGE = 12

/**
 * Разбор непонятного. Один получатель — одна строка, категория ставится
 * получателю: иначе человек сорок раз подряд выбирает «Продукты» для одной и
 * той же «Пятёрочки», а на следующей выписке начинает заново.
 */
export function Unknown({
  rows,
  totalSpend,
  hasCodes,
  onMerchantCategory,
}: UnknownProps): JSX.Element | null {
  const [limit, setLimit] = useState(PAGE)
  const unknown = rows.filter((tx) => tx.source === 'fallback' && tx.amount < 0)
  if (unknown.length === 0) return null

  const groups = groupByMerchant(unknown)
  const shown = groups.slice(0, limit)
  const tail = groups.slice(limit)
  const tailSum = tail.reduce((sum, g) => sum + g.total, 0)
  const unknownSum = groups.reduce((sum, g) => sum + g.total, 0)
  // Сколько «Прочего» останется, если назвать всех показанных сейчас.
  const afterShown = tailSum

  return (
    <section class="f-unknown">
      <div class="f-unknown__head">
        <h2 class="f-eyebrow">Разбор непонятного</h2>
        <span class="f-unknown__share">{formatShare(unknownSum, totalSpend)}% трат</span>
      </div>

      <p class="f-note" style="margin-top:0.5em">
        Один получатель — одна строка, самые дорогие сверху. Категория, поставленная здесь, ложится
        на все его операции и на будущие выписки тоже.
        {shown.length < groups.length
          ? ` Назовёте показанных ${shown.length} — «Прочее» станет ${formatShare(afterShown, totalSpend)}% вместо ${formatShare(unknownSum, totalSpend)}%.`
          : ' Назовёте всех — «Прочее» исчезнет совсем.'}
      </p>

      {hasCodes ? null : (
        <p class="f-note f-hint">
          В этом файле нет кодов операций — только дата, сумма и описание. Т-Банк отдаёт и полную
          выгрузку операций: в ней есть MCC и категория банка, и с ними в «Прочее» попадает заметно
          меньше.
        </p>
      )}

      <ul class="f-unknown__list" role="list">
        {shown.map((group) => (
          <li key={group.key} class="f-unknown__row">
            <div class="f-unknown__line">
              <span class="f-unknown__name" title={group.sample}>
                {group.label}
              </span>
              <Amount class="f-unknown__sum" value={group.total} kopecks="never" />
            </div>
            <label class="f-unknown__pick">
              <span class="f-unknown__count">{group.count} оп.</span>
              <span class="f-sr">Категория для получателя {group.label}</span>
              <select
                value=""
                onChange={(event) => {
                  const next = (event.currentTarget as HTMLSelectElement).value
                  if (isCategory(next)) onMerchantCategory(group.key, next)
                }}
              >
                <option value="">— выбрать —</option>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>

      {tail.length > 0 ? (
        <button type="button" class="f-more" onClick={() => setLimit(limit + PAGE * 2)}>
          Ещё · осталось {tail.length} на {Math.round(tailSum / 100)}
        </button>
      ) : null}
    </section>
  )
}
