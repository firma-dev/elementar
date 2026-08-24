import { useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

export interface FoldProps {
  title: string
  /** Короткая правая приписка: доля, число операций. Не предложение. */
  meta?: string
  /** Раскрыт ли раздел при первом показе. */
  startOpen?: boolean
  /**
   * Раскрытием управляют снаружи.
   *
   * Нужно, когда открыть раздел просит другой блок: «плана на этот период нет
   * → задать план» ведёт в «План и копилку», и раздел должен раскрыться, а не
   * просто подсветиться. Не передан — раздел живёт сам по себе.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
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
export function Fold({
  title,
  meta,
  startOpen = false,
  open: forced,
  onOpenChange,
  children,
}: FoldProps): JSX.Element {
  const [own, setOwn] = useState(startOpen)
  const open = forced ?? own
  const setOpen = (next: boolean): void => {
    setOwn(next)
    onOpenChange?.(next)
  }
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
