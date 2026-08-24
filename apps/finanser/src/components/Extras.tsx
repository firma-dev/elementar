import type { JSX } from 'preact'
import { EXTRA_CATEGORIES, PARENT } from '../model.js'
import type { Category } from '../model.js'
import type { Kopeck } from '../money.js'
import { Amount } from './Amount.js'
import { Fold } from './Fold.js'

export interface ExtrasProps {
  /** Какие дополнительные категории уже включены. */
  enabled: ReadonlySet<string>
  /** Сколько операций и денег ждёт за каждой: ключ → счёт и сумма. */
  pending: ReadonlyMap<Category, { count: number; spend: number }>
  onToggle: (category: Category) => void
}

/**
 * Дополнительные категории.
 *
 * Основных девять — их хватает, чтобы увидеть картину. Двадцать семь сразу это
 * не точность, а работа: выбирая из двадцати семи, человек каждый раз
 * перечитывает список, и половина различий ему не нужна вовсе. Кому-то важно
 * отделить такси от транспорта, кому-то алкоголь от продуктов — но одному
 * человеку не всё сразу.
 *
 * Рядом с каждой стоит цена вопроса: сколько операций и денег из неё сейчас
 * лежит в родительской. Так решение принимается до нажатия, а не после.
 */
export function Extras({ enabled, pending, onToggle }: ExtrasProps): JSX.Element {
  const waiting = EXTRA_CATEGORIES.filter(
    (c) => !enabled.has(c) && (pending.get(c)?.count ?? 0) > 0,
  )
  const on = EXTRA_CATEGORIES.filter((c) => enabled.has(c))

  // Сверху то, за чем что-то стоит, и самое дорогое первым: в списке из
  // тринадцати восемь обычно пусты, и без порядка нужное приходится искать
  // глазами среди «в выписке не встречается».
  const ordered = [...EXTRA_CATEGORIES].sort((a, b) => {
    const aOn = enabled.has(a) ? 1 : 0
    const bOn = enabled.has(b) ? 1 : 0
    if (aOn !== bOn) return bOn - aOn
    return (pending.get(b)?.spend ?? 0) - (pending.get(a)?.spend ?? 0)
  })

  return (
    <Fold
      title="Ещё категории"
      meta={on.length === 0 ? `${waiting.length} есть в выписке` : `включено ${on.length}`}
    >
      <p class="f-note">
        Основных девять — их хватает, чтобы увидеть картину. Остальные включаются по одной: пока
        категория выключена, её траты лежат в родительской, а не пропадают.
      </p>

      <ul class="f-extras" role="list">
        {ordered.map((category) => {
          const has = pending.get(category)
          const isOn = enabled.has(category)
          return (
            <li key={category} class="f-extras__row">
              <button
                type="button"
                class={isOn ? 'f-extra f-extra--on' : 'f-extra'}
                aria-pressed={isOn}
                onClick={() => onToggle(category)}
              >
                {category}
              </button>
              <span class="f-extras__meta">
                {isOn ? (
                  `отдельно от «${PARENT[category] ?? ''}»`
                ) : has === undefined || has.count === 0 ? (
                  'в выписке не встречается'
                ) : (
                  <>
                    {has.count} оп. на <Amount value={has.spend as Kopeck} kopecks="never" /> лежат
                    в «{PARENT[category] ?? ''}»
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </Fold>
  )
}
