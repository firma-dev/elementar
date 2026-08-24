import { useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

export interface FoldProps {
  title: string
  /** Короткая правая приписка: доля, число операций. Не предложение. */
  meta?: string
  /** Раскрыт ли раздел при первом показе. */
  startOpen?: boolean
  children: ComponentChildren
}

/**
 * Сворачиваемый раздел.
 *
 * Годовой экран рос приращением, и к этому моменту вываливал тринадцать блоков
 * подряд, все одного веса. Ответ на вопрос «куда ушли деньги» — период, суммы,
 * график и категории; остальное человек открывает, когда до него дошёл.
 * Закрытый раздел занимает одну строку и при этом остаётся видимым: он не
 * прячется, а ждёт.
 */
export function Fold({ title, meta, startOpen = false, children }: FoldProps): JSX.Element {
  const [open, setOpen] = useState(startOpen)
  return (
    <section class={open ? 'f-fold f-fold--open' : 'f-fold'}>
      <button
        type="button"
        class="f-fold__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="f-fold__sign" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
        <span class="f-eyebrow f-fold__title">{title}</span>
        {meta === undefined ? null : <span class="f-fold__meta">{meta}</span>}
      </button>
      {open ? <div class="f-fold__body">{children}</div> : null}
    </section>
  )
}
