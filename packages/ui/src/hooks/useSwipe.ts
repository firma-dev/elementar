import { useEffect, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'

export type SwipeAxis = 'x' | 'y'

export interface SwipeHandlers {
  axis: SwipeAxis
  /** Смещение от точки касания в px. */
  onMove?: (delta: number) => void
  /** velocity — px/ms в момент отпускания. */
  onEnd?: (delta: number, velocity: number) => void
  /** Порог, после которого жест считается начатым; до него скролл не перехватывается. */
  threshold?: number
  enabled?: boolean
}

interface Tracking {
  id: number
  startX: number
  startY: number
  lastPos: number
  lastAt: number
  velocity: number
  captured: boolean
}

/** Жест перетаскивания: шит, свайп строки. Работает и при reduce — это жест, не анимация. */
export function useSwipe(ref: RefObject<HTMLElement | null>, handlers: SwipeHandlers): void {
  const latest = useRef<SwipeHandlers>(handlers)
  latest.current = handlers

  useEffect(() => {
    const el = ref.current
    if (el === null || handlers.enabled === false) return
    let track: Tracking | null = null

    const pos = (e: PointerEvent): number => (latest.current.axis === 'x' ? e.clientX : e.clientY)

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      track = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastPos: pos(e),
        lastAt: e.timeStamp,
        velocity: 0,
        captured: false,
      }
    }

    const onMove = (e: PointerEvent): void => {
      if (track === null || e.pointerId !== track.id) return
      const dx = e.clientX - track.startX
      const dy = e.clientY - track.startY
      const axis = latest.current.axis
      const main = axis === 'x' ? dx : dy
      const cross = axis === 'x' ? dy : dx
      const threshold = latest.current.threshold ?? 8

      if (!track.captured) {
        if (Math.abs(main) < threshold) return
        // Жест по другой оси — отдаём скроллу.
        if (Math.abs(cross) > Math.abs(main)) {
          track = null
          return
        }
        track.captured = true
        el.setPointerCapture(e.pointerId)
      }

      const now = e.timeStamp
      const dt = now - track.lastAt
      if (dt > 0) track.velocity = (pos(e) - track.lastPos) / dt
      track.lastPos = pos(e)
      track.lastAt = now
      latest.current.onMove?.(main)
    }

    const onUp = (e: PointerEvent): void => {
      if (track === null || e.pointerId !== track.id) return
      const captured = track.captured
      const delta = latest.current.axis === 'x' ? e.clientX - track.startX : e.clientY - track.startY
      const velocity = track.velocity
      if (captured && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      track = null
      if (captured) latest.current.onEnd?.(delta, velocity)
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [ref, handlers.enabled])
}
