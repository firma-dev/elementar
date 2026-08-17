import type { JSX } from 'preact'
import type { Base } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface DividerProps extends Base {
  inset?: boolean
  vertical?: boolean
}

/** Декоративный hairline: --e-line сознательно ниже 3:1, смысла не несёт (§11.7). */
export function Divider({
  inset = false,
  vertical = false,
  class: cls,
  ...rest
}: DividerProps): JSX.Element {
  return (
    <hr
      {...rest}
      class={cx('e-divider', inset && 'e-divider--inset', vertical && 'e-divider--vertical', cls)}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
    />
  )
}
