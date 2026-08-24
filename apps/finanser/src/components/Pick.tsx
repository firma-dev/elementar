import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'

export interface PickProps {
  /** Текущее значение. Пустая строка — ничего не выбрано. */
  value: string
  options: readonly string[]
  /** Что показывать, когда значение пустое. */
  placeholder?: string
  /** Подпись для экранного диктора: видимого заголовка у поля нет. */
  label: string
  /** Тихий вид: без рамки, для плотных строк выписки. */
  quiet?: boolean
  onChange: (value: string) => void
}

/**
 * Выбор из списка. Свой, не нативный `<select>`.
 *
 * Нативное поле рисует операционная система: свои скругления, свою тень, свою
 * стрелку, свой шрифт в списке. В интерфейсе, который весь состоит из прямых
 * рамок и одного OCR, оно выглядит вставленным из другой программы — и
 * поскольку смена категории здесь главное действие, эта чужеродность попадается
 * на глаза чаще всего остального.
 *
 * Взамен — кнопка и список в том же языке: прямые углы, та же рамка, тот же
 * шрифт. Клавиатура сохранена полностью: стрелки, Enter, Esc, Home/End —
 * нативное поле умело это без нашего участия, и терять это нельзя.
 */
export function Pick({
  value,
  options,
  placeholder = '— выбрать —',
  label,
  quiet = false,
  onChange,
}: PickProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listId = useId()

  const close = useCallback(() => setOpen(false), [])

  // Клик мимо закрывает список: открытое меню, которое остаётся висеть, —
  // главный источник ощущения, что интерфейс живёт своей жизнью.
  useEffect(() => {
    if (!open) return
    const away = (event: Event): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open, close])

  useEffect(() => {
    if (open) setActive(Math.max(0, options.indexOf(value)))
  }, [open, options, value])

  const choose = (option: string): void => {
    onChange(option)
    close()
  }

  const onKey = (event: JSX.TargetedKeyboardEvent<HTMLElement>): void => {
    const step = (delta: number): void => {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActive((i) => (i + delta + options.length) % options.length)
    }
    switch (event.key) {
      case 'ArrowDown':
        step(1)
        break
      case 'ArrowUp':
        step(-1)
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (open) {
          const option = options[active]
          if (option !== undefined) choose(option)
        } else setOpen(true)
        break
      case 'Escape':
        if (open) {
          event.preventDefault()
          close()
        }
        break
      default:
        break
    }
  }

  return (
    <div class={quiet ? 'f-pick f-pick--quiet' : 'f-pick'} ref={box}>
      <button
        type="button"
        class="f-pick__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onKeyDown={onKey}
        onClick={() => setOpen(!open)}
      >
        <span class="f-pick__value">{value === '' ? placeholder : value}</span>
        <span class="f-pick__caret" aria-hidden="true" />
      </button>

      {open ? (
        <ul class="f-pick__list" id={listId} role="listbox" aria-label={label}>
          {options.map((option, i) => (
            <li key={option}>
              <button
                type="button"
                role="option"
                aria-selected={option === value}
                class={i === active ? 'f-pick__option f-pick__option--on' : 'f-pick__option'}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(option)}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
