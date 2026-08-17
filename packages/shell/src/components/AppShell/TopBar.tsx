import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { cx } from '@elementar/ui'
import type { Base, Slot } from '@elementar/ui'

export interface TopBarProps extends Base {
  title: Slot
  subtitle?: Slot
  leading?: Slot
  /** До двух действий. */
  actions?: Slot
  presence?: Slot
}

/** Липкая шапка: hairline появляется только когда под ней что-то уехало. */
export function TopBar({
  title,
  subtitle,
  leading,
  actions,
  presence,
  class: cls,
  ...rest
}: TopBarProps): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el === null || typeof IntersectionObserver === 'undefined') return
    const sentinel = el.previousElementSibling
    if (sentinel === null) return
    const io = new IntersectionObserver((entries) => {
      const first = entries[0]
      if (first !== undefined) setScrolled(!first.isIntersecting)
    })
    io.observe(sentinel)
    return () => io.disconnect()
  }, [])

  return (
    <>
      <div class="e-topbar__sentinel" aria-hidden="true" />
      <header {...rest} ref={ref} class={cx('e-topbar', scrolled && 'e-topbar--scrolled', cls)}>
        {leading !== undefined && leading !== null ? <div class="e-topbar__lead">{leading}</div> : null}
        <div class="e-topbar__titles">
          <h1 class="e-topbar__title e-heading e-truncate">{title}</h1>
          {subtitle !== undefined && subtitle !== null ? (
            <div class="e-topbar__subtitle e-caption e-truncate">{subtitle}</div>
          ) : null}
        </div>
        {presence !== undefined && presence !== null ? (
          <div class="e-topbar__presence">{presence}</div>
        ) : null}
        {actions !== undefined && actions !== null ? (
          <div class="e-topbar__actions">{actions}</div>
        ) : null}
      </header>
    </>
  )
}
