import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { CATEGORIES, dayLabel, isCategory } from '../model.js'
import type { Categorized, Category } from '../model.js'
import { merchantLabel } from '../merchant.js'
import { Amount } from './Amount.js'

export interface TxListProps {
  rows: readonly Categorized[]
  onCategory: (id: string, category: Category) => void
}

/** Сколько строк показываем за раз: годовая выписка — это две-три тысячи. */
const PAGE = 60

const SOURCE_HINT: Readonly<Record<Categorized['source'], string>> = {
  manual: 'Категорию поставили вы',
  merchant: 'Категория назначена получателю',
  operation: 'Категория по виду операции: так её назвал банк',
  rule: 'Категория по словарю правил',
  mcc: 'Категория по коду мерчанта (MCC)',
  bank: 'Категория из выписки банка',
  fallback: 'Категорию опознать не удалось',
}

/** Цвет метки говорит, кто поставил категорию. Взято из прототипа. */
const MARK: Readonly<Record<Categorized['source'], string>> = {
  manual: 'var(--el__accent)',
  merchant: 'var(--el__accent)',
  operation: 'var(--el__text)',
  rule: 'var(--el__text)',
  mcc: 'var(--el__text-caption)',
  bank: 'var(--el__text-caption)',
  fallback: 'var(--el__mark)',
}

/**
 * Выписка. Категория правится прямо в строке — правка сильнее любого правила и
 * запоминается (ТЗ §2 п.3). Выбор сделан нативным `<select>`: на телефоне это
 * системное колесо, которое работает без нашего кода.
 */
export function TxList({ rows, onCategory }: TxListProps): JSX.Element {
  const [limit, setLimit] = useState(PAGE)
  const shown = rows.slice(0, limit)

  return (
    <div>
      {shown.map((tx) => (
        <div key={tx.id} class="f-tx">
          <span class="f-tx__day">{dayLabel(tx.date)}</span>
          <span>
            {/* Подпись — разобранное имя получателя; сырое описание остаётся в
                title: иногда только в нём и видно, что это было. */}
            <span class="f-tx__desc" title={tx.description}>
              {merchantLabel(tx.description)}
            </span>
            <label class="f-tx__cat" title={SOURCE_HINT[tx.source]}>
              <span
                class="f-tx__mark"
                style={`background:${MARK[tx.source]};${
                  tx.source === 'fallback' ? 'border:1px solid var(--el__text)' : ''
                }`}
                aria-hidden="true"
              />
              <span class="f-sr">Категория операции «{tx.description}»</span>
              <select
                value={tx.category}
                onChange={(event) => {
                  const next = (event.currentTarget as HTMLSelectElement).value
                  if (isCategory(next)) onCategory(tx.id, next)
                }}
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
          </span>
          <Amount
            class={tx.amount > 0 ? 'f-tx__sum f-tx__sum--in' : 'f-tx__sum'}
            value={tx.amount}
            plus
          />
        </div>
      ))}

      {rows.length > limit ? (
        <button type="button" class="f-more" onClick={() => setLimit(limit + PAGE * 4)}>
          Ещё · осталось {rows.length - limit}
        </button>
      ) : null}
    </div>
  )
}
