import type { JSX } from 'preact'
import { cx, useHaptic } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import { badgeText } from './nav.js'
import type { NavItem } from './nav.js'

export interface TabBarProps extends Base {
  items: readonly NavItem[]
  value?: string
  onChange: (id: string) => void
  ariaLabel: string
}

/** Мобильная проекция навигации: нижняя панель с safe-area. */
export function TabBar({ items, value, onChange, ariaLabel, class: cls, ...rest }: TabBarProps): JSX.Element {
  const haptic = useHaptic()
  return (
    <nav {...rest} class={cx('e-tabbar', cls)} aria-label={ariaLabel}>
      <ul class="e-tabbar__list">
        {items.map((item) => {
          const selected = item.id === value
          const badge = badgeText(item.badge)
          return (
            <li key={item.id} class="e-tabbar__item">
              <button
                type="button"
                class={cx('e-tabbar__button', selected && 'is-selected')}
                data-tone={item.tone}
                aria-current={selected ? 'page' : undefined}
                onClick={() => {
                  haptic('tick')
                  onChange(item.id)
                }}
              >
                <span class="e-tabbar__icon" aria-hidden="true">
                  {item.icon}
                  {badge !== null ? (
                    <span class={cx('e-tabbar__badge', badge === '' && 'e-tabbar__badge--dot')}>{badge}</span>
                  ) : null}
                </span>
                <span class="e-tabbar__label e-caption">{item.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
