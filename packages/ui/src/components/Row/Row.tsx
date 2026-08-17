import type { JSX } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { useSwipe } from '../../hooks/useSwipe.js'

export interface SwipeAction {
  label: string
  icon: Slot
  tone: Tone
  onAction: () => void
  confirm?: boolean
}

export interface RowProps extends Base {
  leading?: Slot
  title: Slot
  subtitle?: Slot
  trailing?: Slot
  /** Левая полоска 2px. */
  tone?: Tone
  selected?: boolean
  /** Выполненная задача: --e-fg-2 + зачёркивание. */
  muted?: boolean
  /** Предложение агента: пунктир + тинт агента (наложение, не запись). */
  proposed?: boolean
  onActivate?: () => void
  swipe?: { right?: SwipeAction; left?: SwipeAction[] }
  href?: string
}

/** Доля ширины строки, после которой свайп срабатывает. */
const TRIGGER_RATIO = 0.4
const VELOCITY_TRIGGER = 0.5

function ActionButton({ action, onDone }: { action: SwipeAction; onDone: () => void }): JSX.Element {
  return (
    <button
      type="button"
      class="e-row__action"
      data-tone={action.tone}
      onClick={() => {
        action.onAction()
        onDone()
      }}
    >
      <span class="e-row__action-icon" aria-hidden="true">
        {action.icon}
      </span>
      <span class="e-row__action-label">{action.label}</span>
    </button>
  )
}

/**
 * Вся строка НЕ превращается в кнопку — иначе ломается выделение текста (§11.8).
 * Кнопки свайпа всегда есть в DOM и доступны с клавиатуры: жест не единственный путь.
 */
export function Row({
  leading,
  title,
  subtitle,
  trailing,
  tone,
  selected = false,
  muted = false,
  proposed = false,
  onActivate,
  swipe,
  href,
  class: cls,
  ...rest
}: RowProps): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<'none' | 'left' | 'right'>('none')
  const dragging = useRef(false)

  const setOffset = useCallback((px: number): void => {
    contentRef.current?.style.setProperty('--e-row-dx', `${px}px`)
  }, [])

  useEffect(() => {
    if (dragging.current) return
    const el = contentRef.current
    if (el === null) return
    if (open === 'none') setOffset(0)
    else if (open === 'left') setOffset(-Math.min(el.offsetWidth * 0.6, 168))
    else setOffset(Math.min(el.offsetWidth * 0.35, 120))
  }, [open, setOffset])

  const leftActions = swipe?.left ?? []
  const rightAction = swipe?.right
  const swipeEnabled = rightAction !== undefined || leftActions.length > 0

  useSwipe(contentRef, {
    axis: 'x',
    enabled: swipeEnabled,
    onMove: (dx) => {
      dragging.current = true
      const limited = dx > 0 && rightAction === undefined ? 0 : dx < 0 && leftActions.length === 0 ? 0 : dx
      setOffset(limited)
    },
    onEnd: (dx, velocity) => {
      dragging.current = false
      const width = contentRef.current?.offsetWidth ?? 1
      const passed = Math.abs(dx) > width * TRIGGER_RATIO || Math.abs(velocity) > VELOCITY_TRIGGER
      if (dx > 0 && rightAction !== undefined && passed) {
        if (rightAction.confirm === true) setOpen('right')
        else {
          setOpen('none')
          setOffset(0)
          rightAction.onAction()
        }
        return
      }
      if (dx < 0 && leftActions.length > 0 && passed) {
        setOpen('left')
        return
      }
      setOpen('none')
      setOffset(0)
    },
  })

  const close = useCallback((): void => {
    setOpen('none')
    setOffset(0)
  }, [setOffset])

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    if (onActivate === undefined) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    onActivate()
  }

  const titleNode = href !== undefined ? (
    <a class="e-row__link" href={href}>
      {title}
    </a>
  ) : (
    title
  )

  return (
    <div
      {...rest}
      class={cx(
        'e-row',
        selected && 'e-row--selected',
        muted && 'e-row--muted',
        proposed && 'e-row--proposed',
        tone !== undefined && 'e-row--toned',
        open !== 'none' && `e-row--open-${open}`,
        cls,
      )}
      data-tone={tone}
    >
      {rightAction !== undefined ? (
        <div
          class="e-row__actions e-row__actions--right"
          onFocusCapture={() => setOpen('right')}
          onBlurCapture={close}
        >
          <ActionButton action={rightAction} onDone={close} />
        </div>
      ) : null}

      {leftActions.length > 0 ? (
        <div
          class="e-row__actions e-row__actions--left"
          onFocusCapture={() => setOpen('left')}
          onBlurCapture={close}
        >
          {leftActions.map((a) => (
            <ActionButton key={a.label} action={a} onDone={close} />
          ))}
        </div>
      ) : null}

      <div
        ref={contentRef}
        class="e-row__content"
        tabIndex={onActivate !== undefined ? 0 : undefined}
        onClick={onActivate}
        onKeyDown={onKeyDown}
      >
        {leading !== undefined && leading !== null ? (
          <div class="e-row__leading">{leading}</div>
        ) : null}
        <div class="e-row__text">
          <div class="e-row__title e-body">{titleNode}</div>
          {subtitle !== undefined && subtitle !== null ? (
            <div class="e-row__subtitle e-body-sm">{subtitle}</div>
          ) : null}
        </div>
        {trailing !== undefined && trailing !== null ? (
          <div class="e-row__trailing">{trailing}</div>
        ) : null}
      </div>
    </div>
  )
}
