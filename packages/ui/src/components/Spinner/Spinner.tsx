import type { JSX } from 'preact'
import type { Base } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface SpinnerProps extends Base {
  size?: 16 | 20 | 24
  label?: string
}

/**
 * Дуга 270°, 900 мс linear. При prefers-reduced-motion дуга скрывается и остаются
 * три пульсирующие точки — переключение чисто на CSS (§11.8).
 */
export function Spinner({ size = 20, label, class: cls, ...rest }: SpinnerProps): JSX.Element {
  return (
    <span
      {...rest}
      class={cx('e-spinner', cls)}
      data-size={size}
      role="status"
      aria-live="off"
      aria-label={label}
    >
      <svg class="e-spinner__arc" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          pathLength="100"
          stroke-dasharray="75 25"
        />
      </svg>
      <span class="e-spinner__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  )
}
