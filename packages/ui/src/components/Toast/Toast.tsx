import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Base } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { subscribeToasts, toast } from './toastStore.js'
import type { ToastRecord } from './toastStore.js'

export type { ToastApi, ToastOptions, ToastRecord } from './toastStore.js'
export { toast, subscribeToasts, getToasts } from './toastStore.js'

export interface ToastViewportProps extends Base {
  /** Мобильная раскладка поднимает стопку над таббаром. */
  withTabBar?: boolean
}

interface Timer {
  remaining: number
  startedAt: number
  handle: number | null
}

/**
 * Единственный компонент с внутренним состоянием — стор глобальный (§11.8).
 * Таймер останавливается на hover и на фокусе внутри.
 */
export function ToastViewport({
  withTabBar = false,
  class: cls,
  ...rest
}: ToastViewportProps): JSX.Element {
  const [items, setItems] = useState<readonly ToastRecord[]>([])
  const [paused, setPaused] = useState(false)
  const timers = useRef<Map<string, Timer>>(new Map())

  useEffect(() => subscribeToasts(setItems), [])

  useEffect(() => {
    const map = timers.current
    // Снимаем таймеры исчезнувших тостов.
    for (const [id, timer] of map) {
      if (items.some((t) => t.id === id)) continue
      if (timer.handle !== null) clearTimeout(timer.handle)
      map.delete(id)
    }

    for (const item of items) {
      if (item.duration === 0) continue
      let timer = map.get(item.id)
      if (timer === undefined) {
        timer = { remaining: item.duration, startedAt: 0, handle: null }
        map.set(item.id, timer)
      }
      if (paused) {
        if (timer.handle !== null) {
          clearTimeout(timer.handle)
          timer.handle = null
          timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
        }
        continue
      }
      if (timer.handle !== null) continue
      timer.startedAt = Date.now()
      timer.handle = window.setTimeout(() => toast.dismiss(item.id), timer.remaining)
    }
  }, [items, paused])

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) {
        if (timer.handle !== null) clearTimeout(timer.handle)
      }
      timers.current.clear()
    },
    [],
  )

  return (
    <div
      {...rest}
      class={cx('e-toasts', withTabBar && 'e-toasts--with-tabbar', cls)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {items.map((item) => (
        <div
          key={item.id}
          class="e-toast"
          data-tone={item.tone === 'neutral' ? undefined : item.tone}
          role={item.tone === 'danger' ? 'alert' : 'status'}
          aria-live={item.tone === 'danger' ? 'assertive' : 'polite'}
        >
          <span class="e-toast__message e-body-sm">{item.message}</span>
          {item.action !== undefined ? (
            <button
              type="button"
              class="e-toast__action"
              onClick={() => {
                item.action?.onAction()
                toast.dismiss(item.id)
              }}
            >
              {item.action.label}
            </button>
          ) : null}
          <button
            type="button"
            class="e-toast__close"
            aria-label="Закрыть уведомление"
            onClick={() => toast.dismiss(item.id)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
