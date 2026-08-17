import type { JSX } from 'preact'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface CardProps extends Base {
  as?: 'div' | 'article' | 'section' | 'a' | 'button'
  elevation?: 0 | 1 | 2 | 3
  /** 0 / 12 / 16 / 24 */
  padding?: 'none' | 'sm' | 'md' | 'lg'
  tone?: Tone
  interactive?: boolean
  header?: Slot
  footer?: Slot
  children?: Slot
  href?: string
  onClick?: JSX.MouseEventHandler<HTMLElement>
}

export function Card({
  as = 'div',
  elevation = 0,
  padding = 'md',
  tone,
  interactive = false,
  header,
  footer,
  children,
  href,
  onClick,
  class: cls,
  ...rest
}: CardProps): JSX.Element {
  const Tag = as
  const clickable = interactive || as === 'a' || as === 'button'
  const props = {
    ...rest,
    class: cx(
      'e-card',
      `e-card--pad-${padding}`,
      `e-card--elev-${elevation}`,
      clickable && 'e-card--interactive',
      tone !== undefined && 'e-card--toned',
      cls,
    ),
    'data-tone': tone,
    onClick,
    ...(as === 'a' ? { href } : {}),
    ...(as === 'button' ? { type: 'button' as const } : {}),
  }

  return (
    <Tag {...props}>
      {header !== undefined && header !== null ? (
        <div class="e-card__header">{header}</div>
      ) : null}
      {children !== undefined && children !== null ? (
        <div class="e-card__body">{children}</div>
      ) : null}
      {footer !== undefined && footer !== null ? (
        <div class="e-card__footer">{footer}</div>
      ) : null}
    </Tag>
  )
}
