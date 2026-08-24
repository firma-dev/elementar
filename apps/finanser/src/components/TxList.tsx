import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { CATEGORIES, dayLabel, isCategory } from '../model.js'
import type { Categorized, Category } from '../model.js'
import { merchantLabel } from '../merchant.js'
import { Amount } from './Amount.js'
import { Pick } from './Pick.js'

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
/** Метка источника категории. Цвет живёт в стилях, здесь только имя вида. */
const MARK: Readonly<Record<Categorized['source'], string>> = {
  manual: 'f-tx__mark--said',
  merchant: 'f-tx__mark--said',
  operation: 'f-tx__mark--sure',
  rule: 'f-tx__mark--sure',
  mcc: 'f-tx__mark--guess',
  bank: 'f-tx__mark--guess',
  fallback: 'f-tx__mark--none',
}

/**
 * Выписка. Категория правится прямо в строке — правка сильнее любого правила и
 * запоминается (ТЗ §2 п.3). Выбор — свой (`Pick`), а не нативный `<select>`:
 * системное поле рисуется по правилам операционной системы и рядом с прямыми
 * рамками корпуса выглядит вставленным из другой программы.
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
            <span class="f-tx__cat" title={SOURCE_HINT[tx.source]}>
              <span class={`f-tx__mark ${MARK[tx.source]}`} aria-hidden="true" />
              <Pick
                quiet
                value={tx.category}
                options={CATEGORIES}
                label={`Категория операции «${tx.description}»`}
                onChange={(next) => {
                  if (isCategory(next)) onCategory(tx.id, next)
                }}
              />
            </span>
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
