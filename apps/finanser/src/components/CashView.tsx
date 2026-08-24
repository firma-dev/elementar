import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Categorized, Category } from '../model.js'
import { isCategory, dayLabel } from '../model.js'
import type { Kopeck } from '../money.js'
import { formatAmount, formatShare, parseAmount } from '../money.js'
import { splitLeft, splitTotal, withdrawals } from '../cash.js'
import type { CashPart, CashSplits } from '../cash.js'
import { Amount } from './Amount.js'
import { Fold } from './Fold.js'
import { Pick } from './Pick.js'

export interface CashViewProps {
  rows: readonly Categorized[]
  splits: CashSplits
  /** Трата за отрезок — чтобы сказать, какую долю занимают неразобранные купюры. */
  totalSpend: Kopeck
  options: readonly Category[]
  onSplit: (id: string, parts: readonly CashPart[]) => void
}

/**
 * Наличные.
 *
 * Сняли восемь тысяч — и дальше они невидимы: одна строка вместо продуктов,
 * такси и кофе. Банк тут не поможет, он и сам не знает, куда ушли купюры;
 * знает только человек. Поэтому здесь не отчёт, а место, где он рассказывает —
 * и делает это дёшево: снятие, несколько сумм, готово.
 *
 * Само снятие при этом не переписывается: банк сказал правду, со счёта ушли
 * восемь тысяч. Доли ложатся поверх отдельными тратами (Д-015).
 */
export function CashView({
  rows,
  splits,
  totalSpend,
  options,
  onSplit,
}: CashViewProps): JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null)
  const list = withdrawals(rows)
  if (list.length === 0) return null

  const unsorted = list.reduce(
    (sum, tx) => sum + Math.abs(tx.amount) - splitTotal(splits[tx.id] ?? []),
    0,
  )

  return (
    <Fold
      title="Наличные"
      meta={
        unsorted <= 0 ? 'разобраны' : `${formatShare(unsorted as Kopeck, totalSpend)}% трат вслепую`
      }
    >
      <p class="f-note">
        Снятые купюры выписка не видит: банк и сам не знает, куда они ушли. Пока снятие не
        разложено, эти деньги в картине трат отсутствуют — то есть картина занижена ровно на них.
      </p>

      <ul class="f-cash" role="list">
        {list.map((tx) => {
          const parts = splits[tx.id] ?? []
          const left = splitLeft(tx.amount, parts)
          const isOpen = open === tx.id
          return (
            <li key={tx.id} class="f-cash__row">
              <button
                type="button"
                class="f-cash__line"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : tx.id)}
              >
                <span class="f-cash__day">{dayLabel(tx.date)}</span>
                <Amount class="f-cash__sum" value={tx.amount} kopecks="never" />
                <span class={left === 0 ? 'f-cash__left f-cash__left--done' : 'f-cash__left'}>
                  {left === 0 ? (
                    'разобрано'
                  ) : left < 0 ? (
                    <>
                      перебор на <Amount value={-left as Kopeck} kopecks="never" />
                    </>
                  ) : (
                    <>
                      осталось <Amount value={left} kopecks="never" />
                    </>
                  )}
                </span>
              </button>

              {isOpen ? (
                <Editor
                  parts={parts}
                  left={left}
                  options={options}
                  onChange={(next) => onSplit(tx.id, next)}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </Fold>
  )
}

/**
 * Правка одного снятия.
 *
 * Новая доля добавляется с остатком, уже вписанным в поле: чаще всего человек
 * раскладывает снятие целиком, и последняя доля — это ровно то, что осталось.
 * Заставлять его считать вычитание в уме незачем.
 */
function Editor({
  parts,
  left,
  options,
  onChange,
}: {
  parts: readonly CashPart[]
  left: Kopeck
  options: readonly Category[]
  onChange: (parts: readonly CashPart[]) => void
}): JSX.Element {
  const set = (i: number, patch: Partial<CashPart>): void => {
    onChange(parts.map((part, at) => (at === i ? { ...part, ...patch } : part)))
  }

  return (
    <div class="f-cash__edit">
      {parts.map((part, i) => (
        <div key={i} class="f-cash__part">
          <Pick
            value={part.category}
            options={options}
            label="Категория доли"
            onChange={(next) => {
              if (isCategory(next)) set(i, { category: next })
            }}
          />
          <input
            class="f-cash__amount"
            type="text"
            inputMode="decimal"
            aria-label="Сумма доли"
            value={formatAmount(part.amount, { kopecks: 'auto', abs: true })}
            onChange={(event) => {
              const raw = (event.currentTarget as HTMLInputElement).value
              set(i, { amount: Math.abs(parseAmount(raw) ?? 0) as Kopeck })
            }}
          />
          <button
            type="button"
            class="f-linkish f-linkish--danger"
            onClick={() => onChange(parts.filter((_, at) => at !== i))}
          >
            убрать
          </button>
        </div>
      ))}

      {/* Когда раскладывать нечего, кнопки нет. Раньше она оставалась и молча
          не работала: новая доля создавалась на остаток, остаток был нулём, а
          нулевые доли выбрасываются до записи. Человек нажимал, ничего не
          появлялось, и почему — не говорилось. Кнопка, которая не делает
          ничего, хуже её отсутствия: рядом с ней перестают верить остальным. */}
      {left > 0 ? (
        <button
          type="button"
          class="f-go f-go--small"
          onClick={() =>
            onChange([...parts, { category: options[0] ?? 'Прочее', amount: left as Kopeck }])
          }
        >
          добавить долю
        </button>
      ) : null}
    </div>
  )
}
