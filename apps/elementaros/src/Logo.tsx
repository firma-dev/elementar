import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
// Канон §6: логотип — отдельный SVG, лежит рядом с каноном. Отсюда он и берётся,
// а не копией внутри приложения: копия разошлась бы с оригиналом молча.
// Разметкой, а не картинкой, — иначе знак не возьмёт `currentColor` и не
// перекрасится ни в тёмной теме, ни на синем экране.
import mark from '../../../elementar.svg?raw'

/** Счётчик экземпляров: см. ниже про идентификаторы маски. */
let instances = 0

export function Logo({ class: cls }: { class?: string }): JSX.Element {
  /**
   * Идентификаторы маски и обрезки внутри файла уникальны только внутри
   * одного экземпляра. Знак стоит на странице дважды — на обложке и в финале, —
   * и два одинаковых id в документе это невалидная разметка. Замена делается
   * один раз на экземпляр и переживает перерисовку.
   */
  const [html] = useState(() => {
    instances += 1
    return mark.replaceAll('_497_888', `-${instances}`)
  })

  return <span class={cls} dangerouslySetInnerHTML={{ __html: html }} />
}
