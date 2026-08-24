import type { JSX } from 'preact'
import { formatAmount } from '../money.js'
import type { FormatOptions, Kopeck } from '../money.js'

export interface AmountProps extends FormatOptions {
  value: Kopeck
  class?: string
}

/**
 * Сумма. Знак рубля не выводится (Д-014), второго шрифта нет — весь текст
 * корпуса и так набран OCR (Д-017), поэтому цифра не нуждается в переключателе.
 */
export function Amount({ value, class: cls, ...format }: AmountProps): JSX.Element {
  return <span class={cls}>{formatAmount(value, format)}</span>
}
