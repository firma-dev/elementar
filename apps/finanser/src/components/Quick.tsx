import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Category } from '../model.js'
import { parseQuick } from '../quick.js'
import { formatAmount } from '../money.js'
import { Pick } from './Pick.js'

interface Props {
  /** Категории, доступные для выбора. */
  options: readonly string[]
  /** Записать. Возвращает идентификатор — по нему потом отменяют. */
  onAdd: (
    amount: number,
    description: string,
    category: Category | null,
  ) => string
  onCategory: (id: string, category: Category) => void
  onDrop: (id: string) => void
}

interface Added {
  id: string
  amount: number
  description: string
  category: Category
}

/**
 * Быстрая запись — главное действие каждого дня.
 *
 * Одно поле. Выписка приезжает раз в месяц, а наличные тратятся сегодня, и
 * между «потратил» и «записал» должно быть одно движение, иначе не записывают
 * вовсе. Форма из четырёх полей — это четыре решения перед каждой чашкой кофе.
 *
 * Что понято, показывается строкой под полем: сумма, описание, категория.
 * Категория тут же меняется, запись тут же убирается. Показывать разбор
 * обязательно — угадывание, которого не видно, человек не может ни проверить,
 * ни поправить, и перестаёт доверять всему остальному.
 */
export function Quick({ options, onAdd, onCategory, onDrop }: Props): JSX.Element {
  const [text, setText] = useState('')
  const [added, setAdded] = useState<Added | null>(null)

  const parsed = parseQuick(text)

  const commit = (): void => {
    if (parsed === null) return
    const category = parsed.category ?? ('Прочее' as Category)
    const id = onAdd(parsed.amount, parsed.description, parsed.category)
    setAdded({ id, amount: parsed.amount, description: parsed.description, category })
    setText('')
  }

  return (
    <div class="f-quick">
      <form
        class="f-quick__form"
        onSubmit={(event) => {
          event.preventDefault()
          commit()
        }}
      >
        <input
          class="f-quick__input"
          type="text"
          value={text}
          enterkeyhint="done"
          autocomplete="off"
          aria-label="Записать трату: что и сколько"
          placeholder="кофе 250"
          onInput={(event) => setText((event.currentTarget as HTMLInputElement).value)}
        />
        {/* Кнопка появляется, только когда есть что записать: пустая кнопка
            рядом с пустым полем — это просьба что-то сделать, а не помощь. */}
        {parsed !== null ? (
          <button type="submit" class="f-go f-go--small">
            записать
          </button>
        ) : null}
      </form>

      {/* Подсказка вместо инструкции: показывается, пока человек не начал
          писать, и исчезает, как только стало ясно, что он и так умеет. */}
      {text === '' && added === null ? (
        <p class="f-quick__hint">
          Что и сколько — одной строкой. «+» в начале, если это приход.
        </p>
      ) : null}

      {added !== null ? (
        <div class="f-quick__added">
          <span class="f-quick__what">
            {added.description} · <span class="f-num">{formatAmount(added.amount)}</span>
          </span>
          <Pick
            value={added.category}
            options={options}
            label="Категория записанного"
            quiet
            onChange={(next) => {
              onCategory(added.id, next as Category)
              setAdded({ ...added, category: next as Category })
            }}
          />
          <button
            type="button"
            class="f-linkish f-linkish--danger"
            onClick={() => {
              onDrop(added.id)
              setAdded(null)
            }}
          >
            убрать
          </button>
        </div>
      ) : null}
    </div>
  )
}
