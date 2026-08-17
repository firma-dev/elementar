import { useEffect, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'

export interface LongPressOptions {
  onLongPress: () => void
  /** Задержка удержания, по умолчанию 450 мс. */
  delay?: number
  /** Смещение, после которого нажатие считается скроллом и отменяется. */
  moveTolerance?: number
  enabled?: boolean
}

/** Длинное нажатие: контекстное меню на строке без превращения строки в кнопку. */
export function useLongPress(
  ref: RefObject<HTMLElement | null>,
  options: LongPressOptions,
): void {
  const latest = useRef<LongPressOptions>(options)
  latest.current = options

  useEffect(() => {
    const el = ref.current
    if (el === null || options.enabled === false) return
    let timer: number | null = null
    let start: { x: number; y: number } | null = null

    const cancel = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      start = null
    }

    const onDown = (e: PointerEvent): void => {
      start = { x: e.clientX, y: e.clientY }
      timer = window.setTimeout(() => {
        timer = null
        latest.current.onLongPress()
      }, latest.current.delay ?? 450)
    }

    const onMove = (e: PointerEvent): void => {
      if (start === null) return
      const tolerance = latest.current.moveTolerance ?? 10
      if (Math.abs(e.clientX - start.x) > tolerance || Math.abs(e.clientY - start.y) > tolerance) {
        cancel()
      }
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', cancel)
    el.addEventListener('pointercancel', cancel)
    el.addEventListener('contextmenu', cancel)
    return () => {
      cancel()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', cancel)
      el.removeEventListener('pointercancel', cancel)
      el.removeEventListener('contextmenu', cancel)
    }
  }, [ref, options.enabled])
}
