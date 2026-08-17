import type { JSX } from 'preact'
import { useCallback, useRef, useState } from 'preact/hooks'
import type { Base, Slot } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { warnOnce } from '../../utils/env.js'
import { useFlip } from '../../hooks/useFlip.js'
import { Skeleton } from '../Skeleton/Skeleton.js'

export interface ListViewProps<T> extends Base {
  items: readonly T[]
  getKey: (item: T) => string
  renderItem: (item: T, index: number) => Slot
  header?: Slot
  footer?: Slot
  empty?: Slot
  loading?: boolean
  skeletonCount?: number
  dividers?: 'none' | 'inset' | 'full'
  reorder?: {
    onReorder: (key: string, beforeKey: string | null) => void
    handle?: 'row' | 'grip'
  }
  flip?: boolean
  ariaLabel: string
}

const GRIP = (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path
      d="M7 5h.01M13 5h.01M7 10h.01M13 10h.01M7 15h.01M13 15h.01"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
    />
  </svg>
)

/** Порог, после которого длинное нажатие на строке начинает перетаскивание. */
const LONG_PRESS_MS = 420

interface DragState {
  key: string
  index: number
  startY: number
  /** Центры строк на момент начала перетаскивания. */
  centers: readonly number[]
  /** Позиция вставки в списке БЕЗ перетаскиваемой строки. */
  targetIndex: number
}

/**
 * Виртуализации в v1 нет: при items.length > 300 в dev печатается предупреждение,
 * холодная часть списка вообще не материализуется (§3.8).
 */
export function ListView<T>({
  items,
  getKey,
  renderItem,
  header,
  footer,
  empty,
  loading = false,
  skeletonCount = 5,
  dividers = 'inset',
  reorder,
  flip = false,
  ariaLabel,
  class: cls,
  ...rest
}: ListViewProps<T>): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const longPress = useRef<number | null>(null)

  const keys = items.map(getKey)
  useFlip(listRef, keys, flip && drag === null)

  if (items.length > 300) {
    warnOnce(`ListView «${ariaLabel}»: ${items.length} элементов без виртуализации`)
  }

  const itemElements = useCallback((): HTMLElement[] => {
    const root = listRef.current
    if (root === null) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'))
  }, [])

  const finishDrag = useCallback(
    (commit: boolean): void => {
      const state = dragRef.current
      dragRef.current = null
      for (const el of itemElements()) {
        el.style.removeProperty('--e-list-dy')
        el.classList.remove('e-list__item--dragging')
      }
      setDrag(null)
      if (!commit || state === null || reorder === undefined) return
      // Вставка на собственное место — не перестановка.
      if (state.targetIndex === state.index) return
      const without = keys.filter((k) => k !== state.key)
      const beforeKey = without[state.targetIndex] ?? null
      reorder.onReorder(state.key, beforeKey)
    },
    [itemElements, keys, reorder],
  )

  const onPointerMove = useCallback(
    (e: PointerEvent): void => {
      const state = dragRef.current
      if (state === null) return
      const dy = e.clientY - state.startY
      const own = itemElements()[state.index]
      if (own === undefined) return
      own.style.setProperty('--e-list-dy', `${dy}px`)

      const ownCenter = (state.centers[state.index] ?? 0) + dy
      // Позиция вставки = сколько чужих центров осталось выше перетаскиваемого.
      let target = 0
      for (let i = 0; i < state.centers.length; i++) {
        if (i === state.index) continue
        const c = state.centers[i]
        if (c !== undefined && c < ownCenter) target += 1
      }
      if (target !== state.targetIndex) {
        dragRef.current = { ...state, targetIndex: target }
        setDrag(dragRef.current)
      }
    },
    [itemElements],
  )

  const beginDrag = useCallback(
    (key: string, index: number, e: PointerEvent): void => {
      const els = itemElements()
      const centers = els.map((el) => {
        const r = el.getBoundingClientRect()
        return r.top + r.height / 2
      })
      const state: DragState = { key, index, startY: e.clientY, centers, targetIndex: index }
      dragRef.current = state
      setDrag(state)
      els[index]?.classList.add('e-list__item--dragging')
      const onUp = (): void => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        finishDrag(true)
      }
      const onCancel = (): void => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        finishDrag(false)
      }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [finishDrag, itemElements, onPointerMove],
  )

  const onItemPointerDown = (key: string, index: number) => (e: JSX.TargetedPointerEvent<HTMLElement>): void => {
    if (reorder === undefined || (reorder.handle ?? 'row') !== 'row') return
    const native = e as unknown as PointerEvent
    if (longPress.current !== null) window.clearTimeout(longPress.current)
    longPress.current = window.setTimeout(() => beginDrag(key, index, native), LONG_PRESS_MS)
    const cancel = (): void => {
      if (longPress.current !== null) window.clearTimeout(longPress.current)
      longPress.current = null
      window.removeEventListener('pointerup', cancel)
      window.removeEventListener('pointermove', cancel)
    }
    window.addEventListener('pointerup', cancel)
    window.addEventListener('pointermove', cancel)
  }

  const onGripKeyDown = (key: string, index: number) => (
    e: JSX.TargetedKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (reorder === undefined) return
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const next = e.key === 'ArrowUp' ? index - 1 : index + 1
    if (next < 0 || next >= keys.length) return
    const without = keys.filter((k) => k !== key)
    reorder.onReorder(key, without[next] ?? null)
  }

  const body = loading ? (
    Array.from({ length: skeletonCount }, (_, i) => (
      <div class="e-list__item" key={`sk-${i}`}>
        <Skeleton variant="row" />
      </div>
    ))
  ) : items.length === 0 ? null : (
    items.map((item, index) => {
      const key = getKey(item)
      const isDragging = drag !== null && drag.key === key
      return (
        <div
          class={cx('e-list__item', isDragging && 'e-list__item--dragging')}
          key={key}
          data-flip-key={key}
          role="listitem"
          aria-grabbed={reorder !== undefined ? (isDragging ? 'true' : 'false') : undefined}
          onPointerDown={onItemPointerDown(key, index)}
        >
          {reorder !== undefined && reorder.handle === 'grip' ? (
            <button
              type="button"
              class="e-list__grip"
              aria-label={`Переместить: ${key}`}
              onPointerDown={(e) => beginDrag(key, index, e as unknown as PointerEvent)}
              onKeyDown={onGripKeyDown(key, index)}
            >
              {GRIP}
            </button>
          ) : null}
          <div class="e-list__item-body">{renderItem(item, index)}</div>
        </div>
      )
    })
  )

  return (
    <div {...rest} class={cx('e-list', `e-list--div-${dividers}`, cls)}>
      {header !== undefined && header !== null ? (
        <div class="e-list__header">{header}</div>
      ) : null}
      <div class="e-list__items" role="list" aria-label={ariaLabel} aria-busy={loading ? 'true' : undefined} ref={listRef}>
        {body}
      </div>
      {!loading && items.length === 0 && empty !== undefined && empty !== null ? (
        <div class="e-list__empty">{empty}</div>
      ) : null}
      {footer !== undefined && footer !== null ? (
        <div class="e-list__footer">{footer}</div>
      ) : null}
    </div>
  )
}
