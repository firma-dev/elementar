import type { JSX } from 'preact'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { bp } from '../../tokens.js'
import { useFocusTrap } from '../../hooks/useFocusTrap.js'
import { useMediaQuery } from '../../hooks/useMediaQuery.js'
import { useSwipe } from '../../hooks/useSwipe.js'
import { Button } from '../Button/Button.js'

export type Presentation = 'auto' | 'dialog' | 'sheet' | 'popover'

export type OverlayCloseReason = 'backdrop' | 'escape' | 'swipe' | 'action'

export interface OverlayProps extends Base {
  open: boolean
  onClose: (reason: OverlayCloseReason) => void
  /** 'auto': ширина < 768px → sheet, иначе dialog. */
  presentation?: Presentation
  title?: string
  description?: string
  /** dialog: 380 / 520 / 720 */
  size?: 'sm' | 'md' | 'lg'
  detents?: ('content' | 'full')[]
  dismissible?: boolean
  /** Обязателен для popover. */
  anchor?: HTMLElement | null
  primaryAction?: { label: string; onAction: () => void; tone?: Tone; loading?: boolean }
  secondaryAction?: { label: string; onAction: () => void }
  footer?: Slot
  children: Slot
}

/** Шит закрывается при смещении > 30 % высоты или скорости > 0.5 px/ms. */
const SHEET_CLOSE_RATIO = 0.3
const SHEET_CLOSE_VELOCITY = 0.5

export function Overlay({
  open,
  onClose,
  presentation = 'auto',
  title,
  description,
  size = 'md',
  detents = ['content'],
  dismissible = true,
  anchor,
  primaryAction,
  secondaryAction,
  footer,
  children,
  class: cls,
  ...rest
}: OverlayProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  // Жест закрытия живёт на ручке: иначе он перехватывал бы скролл содержимого.
  const grabberRef = useRef<HTMLDivElement>(null)
  const isCompact = !useMediaQuery(`(min-width: ${bp.md}px)`)
  const mode: Exclude<Presentation, 'auto'> =
    presentation === 'auto' ? (isCompact ? 'sheet' : 'dialog') : presentation
  const auto = useId()
  const titleId = `e-overlay-${auto}-title`
  const descId = `e-overlay-${auto}-desc`
  const [detent, setDetent] = useState<'content' | 'full'>(detents[0] ?? 'content')

  useFocusTrap(panelRef, open && mode !== 'popover')

  // Esc закрывает всегда, если оверлей закрываемый.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (dismissible) onClose('escape')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissible, onClose])

  // Блокировка скролла body без прыжка: scrollbar-gutter: stable в reset.
  useEffect(() => {
    if (!open || mode === 'popover') return
    document.body.classList.add('e-scroll-locked')
    return () => document.body.classList.remove('e-scroll-locked')
  }, [open, mode])

  // Позиция поповера считается от якоря и пишется в переменные, не в inline-стиль.
  useLayoutEffect(() => {
    if (!open || mode !== 'popover') return
    const panel = panelRef.current
    if (panel === null || anchor === null || anchor === undefined) return
    const r = anchor.getBoundingClientRect()
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    const gap = 8
    const left = Math.min(Math.max(gap, r.left), window.innerWidth - pw - gap)
    const below = r.bottom + gap
    const top = below + ph > window.innerHeight ? Math.max(gap, r.top - ph - gap) : below
    panel.style.setProperty('--e-pop-x', `${Math.round(left)}px`)
    panel.style.setProperty('--e-pop-y', `${Math.round(top)}px`)
  }, [open, mode, anchor, children])

  const setSheetOffset = useCallback((px: number): void => {
    panelRef.current?.style.setProperty('--e-sheet-dy', `${px}px`)
  }, [])

  useSwipe(grabberRef, {
    axis: 'y',
    enabled: open && mode === 'sheet' && dismissible,
    onMove: (dy) => {
      // Резина вверх: движение вверх гасится, вниз идёт один в один.
      setSheetOffset(dy < 0 ? dy / 4 : dy)
    },
    onEnd: (dy, velocity) => {
      const h = panelRef.current?.offsetHeight ?? 1
      if (dy > h * SHEET_CLOSE_RATIO || velocity > SHEET_CLOSE_VELOCITY) {
        setSheetOffset(0)
        onClose('swipe')
        return
      }
      if (dy < -40 && detents.includes('full')) setDetent('full')
      setSheetOffset(0)
    },
  })

  if (!open) return null

  const labelled = title !== undefined ? titleId : undefined
  const described = description !== undefined ? descId : undefined

  const panel = (
    <div
      {...rest}
      ref={panelRef}
      class={cx(
        'e-overlay__panel',
        `e-overlay__panel--${mode}`,
        mode === 'dialog' && `e-overlay__panel--${size}`,
        mode === 'sheet' && `e-overlay__panel--detent-${detent}`,
        cls,
      )}
      role="dialog"
      aria-modal={mode === 'popover' ? undefined : 'true'}
      aria-labelledby={labelled}
      aria-describedby={described}
    >
      {mode === 'sheet' ? (
        <div class="e-overlay__grabber" ref={grabberRef} aria-hidden="true">
          <div class="e-overlay__handle" />
        </div>
      ) : null}
      {title !== undefined ? (
        <h2 class="e-overlay__title e-heading" id={titleId}>
          {title}
        </h2>
      ) : null}
      {description !== undefined ? (
        <p class="e-overlay__desc e-body-sm" id={descId}>
          {description}
        </p>
      ) : null}
      <div class="e-overlay__body">{children}</div>
      {footer !== undefined && footer !== null ? (
        <div class="e-overlay__footer">{footer}</div>
      ) : primaryAction !== undefined || secondaryAction !== undefined ? (
        <div class="e-overlay__footer">
          {secondaryAction !== undefined ? (
            <Button variant="ghost" size="md" onClick={secondaryAction.onAction}>
              {secondaryAction.label}
            </Button>
          ) : null}
          {primaryAction !== undefined ? (
            <Button
              variant="primary"
              size="md"
              tone={primaryAction.tone}
              loading={primaryAction.loading ?? false}
              onClick={primaryAction.onAction}
            >
              {primaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )

  return (
    <div class={cx('e-overlay', `e-overlay--${mode}`)}>
      <div
        class="e-overlay__scrim"
        aria-hidden="true"
        onClick={() => {
          if (dismissible) onClose('backdrop')
        }}
      />
      {panel}
    </div>
  )
}
