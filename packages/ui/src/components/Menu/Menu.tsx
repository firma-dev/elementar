import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { bp } from '../../tokens.js'
import { useMediaQuery } from '../../hooks/useMediaQuery.js'

export interface MenuItem {
  id: string
  label: string
  icon?: Slot
  tone?: Tone
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuItem | { type: 'separator' } | { type: 'label'; label: string }

export interface MenuProps extends Base {
  items: MenuEntry[]
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: HTMLElement | null
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  presentation?: 'auto' | 'popover' | 'sheet'
  ariaLabel: string
}

function isItem(entry: MenuEntry): entry is MenuItem {
  return !('type' in entry)
}

export function Menu({
  items,
  open,
  onOpenChange,
  anchor,
  placement = 'bottom-start',
  presentation = 'auto',
  ariaLabel,
  class: cls,
  ...rest
}: MenuProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const isCompact = !useMediaQuery(`(min-width: ${bp.md}px)`)
  const mode = presentation === 'auto' ? (isCompact ? 'sheet' : 'popover') : presentation

  const focusItem = (delta: number, absolute?: 'first' | 'last'): void => {
    const root = panelRef.current
    if (root === null) return
    const nodes = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])'),
    )
    if (nodes.length === 0) return
    const current = nodes.findIndex((n) => n === document.activeElement)
    let next: number
    if (absolute === 'first') next = 0
    else if (absolute === 'last') next = nodes.length - 1
    else next = (current + delta + nodes.length) % nodes.length
    nodes[next]?.focus()
  }

  // Фокус уходит в меню при открытии и возвращается на якорь при закрытии.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => focusItem(0, 'first'), 0)
    return () => {
      clearTimeout(t)
      anchor?.focus()
    }
  }, [open, anchor])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChange(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        focusItem(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        focusItem(-1)
      } else if (e.key === 'Home') {
        e.preventDefault()
        focusItem(0, 'first')
      } else if (e.key === 'End') {
        e.preventDefault()
        focusItem(0, 'last')
      } else if (e.key === 'Tab') {
        onOpenChange(false)
      }
    }
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) === true) return
      if (anchor?.contains(target) === true) return
      onOpenChange(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, onOpenChange, anchor])

  useLayoutEffect(() => {
    if (!open || mode !== 'popover') return
    const panel = panelRef.current
    if (panel === null || anchor === null) return
    const r = anchor.getBoundingClientRect()
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    const gap = 6
    const wantLeft = placement.endsWith('end') ? r.right - pw : r.left
    const left = Math.min(Math.max(gap, wantLeft), window.innerWidth - pw - gap)
    const wantTop = placement.startsWith('top') ? r.top - ph - gap : r.bottom + gap
    const top =
      wantTop + ph > window.innerHeight
        ? Math.max(gap, r.top - ph - gap)
        : Math.max(gap, wantTop)
    panel.style.setProperty('--e-pop-x', `${Math.round(left)}px`)
    panel.style.setProperty('--e-pop-y', `${Math.round(top)}px`)
  }, [open, mode, anchor, placement, items])

  if (!open) return null

  return (
    <div class={cx('e-menu-layer', `e-menu-layer--${mode}`)}>
      <div
        class="e-menu__scrim"
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
      />
      <div
        {...rest}
        ref={panelRef}
        class={cx('e-menu', `e-menu--${mode}`, cls)}
        role="menu"
        aria-label={ariaLabel}
      >
        {mode === 'sheet' ? <div class="e-menu__handle" aria-hidden="true" /> : null}
        {items.map((entry, i) => {
          if (!isItem(entry)) {
            if (entry.type === 'separator') {
              return <div class="e-menu__separator" key={`sep-${i}`} role="separator" />
            }
            return (
              <div class="e-menu__group e-overline" key={`label-${i}`} role="presentation">
                {entry.label}
              </div>
            )
          }
          const role = entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'
          return (
            <button
              key={entry.id}
              type="button"
              class="e-menu__item"
              role={role}
              data-tone={entry.tone}
              disabled={entry.disabled ?? false}
              aria-checked={entry.checked}
              tabIndex={-1}
              onClick={() => {
                entry.onSelect()
                onOpenChange(false)
              }}
            >
              {entry.icon !== undefined && entry.icon !== null ? (
                <span class="e-menu__icon" aria-hidden="true">
                  {entry.icon}
                </span>
              ) : (
                <span class="e-menu__icon" aria-hidden="true" />
              )}
              <span class="e-menu__label">{entry.label}</span>
              {entry.checked === true ? (
                <span class="e-menu__check" aria-hidden="true">
                  <svg viewBox="0 0 20 20" focusable="false">
                    <path
                      d="M4 10.5l4 4 8-9"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
              ) : entry.shortcut !== undefined ? (
                <span class="e-menu__shortcut e-caption">{entry.shortcut}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
