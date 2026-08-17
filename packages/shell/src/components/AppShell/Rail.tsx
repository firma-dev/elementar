import type { JSX } from 'preact'
import { cx } from '@elementar/ui'
import type { Base, Slot } from '@elementar/ui'
import { badgeText } from './nav.js'
import type { NavItem } from './nav.js'

export interface RailProps extends Base {
  items: readonly NavItem[]
  value?: string
  onChange: (id: string) => void
  ariaLabel: string
  header?: Slot
  footer?: Slot
}

/** Десктопная проекция той же навигации. */
export function Rail({
  items,
  value,
  onChange,
  ariaLabel,
  header,
  footer,
  class: cls,
  ...rest
}: RailProps): JSX.Element {
  return (
    <nav {...rest} class={cx('e-rail', cls)} aria-label={ariaLabel}>
      {header !== undefined && header !== null ? <div class="e-rail__header">{header}</div> : null}
      <ul class="e-rail__list">
        {items.map((item) => {
          const selected = item.id === value
          const badge = badgeText(item.badge)
          return (
            <li key={item.id}>
              <button
                type="button"
                class={cx('e-rail__button', selected && 'is-selected')}
                data-tone={item.tone}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onChange(item.id)}
              >
                <span class="e-rail__icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span class="e-rail__label e-body">{item.label}</span>
                {badge !== null ? (
                  <span class={cx('e-rail__badge', badge === '' && 'e-rail__badge--dot')}>{badge}</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
      {footer !== undefined && footer !== null ? <div class="e-rail__footer">{footer}</div> : null}
    </nav>
  )
}
