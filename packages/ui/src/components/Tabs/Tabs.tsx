import type { JSX } from 'preact'
import { useRef } from 'preact/hooks'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface TabItem {
  id: string
  label: string
  icon?: Slot
  badge?: number | 'dot'
  tone?: Tone
}

export interface TabsProps extends Base {
  items: TabItem[]
  value: string
  onValueChange: (id: string) => void
  variant?: 'segmented' | 'underline'
  scrollable?: boolean
  ariaLabel: string
}

/** Порядок сегментов постоянен: цвет не единственный носитель смысла (§11.7). */
export function Tabs({
  items,
  value,
  onValueChange,
  variant = 'segmented',
  scrollable = false,
  ariaLabel,
  class: cls,
  ...rest
}: TabsProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  const focusAt = (index: number): void => {
    const root = listRef.current
    if (root === null) return
    const buttons = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const target = buttons[(index + buttons.length) % buttons.length]
    target?.focus()
  }

  const onKeyDown = (index: number) => (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void => {
    const last = items.length - 1
    let next: number | null = null
    if (e.key === 'ArrowRight') next = index === last ? 0 : index + 1
    else if (e.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next === null) return
    e.preventDefault()
    const item = items[next]
    if (item === undefined) return
    onValueChange(item.id)
    focusAt(next)
  }

  return (
    <div
      {...rest}
      ref={listRef}
      class={cx('e-tabs', `e-tabs--${variant}`, scrollable && 'e-tabs--scrollable', cls)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => {
        const active = item.id === value
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            class={cx('e-tab', active && 'e-tab--active')}
            data-tone={item.tone}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(item.id)}
            onKeyDown={onKeyDown(index)}
          >
            {item.icon !== undefined && item.icon !== null ? (
              <span class="e-tab__icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            <span class="e-tab__label">{item.label}</span>
            {item.badge === 'dot' ? (
              <span class="e-tab__dot" aria-hidden="true" />
            ) : typeof item.badge === 'number' && item.badge > 0 ? (
              <span class="e-tab__badge e-num">{item.badge}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
