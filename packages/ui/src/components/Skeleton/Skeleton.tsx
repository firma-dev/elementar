import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { Base } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { SKELETON_DELAY_MS } from '../../tokens.js'

export interface SkeletonProps extends Base {
  variant?: 'text' | 'row' | 'card' | 'circle' | 'block'
  width?: string | number
  height?: string | number
  lines?: number
}

function size(v: string | number | undefined): string | undefined {
  if (v === undefined) return undefined
  return typeof v === 'number' ? `${v}px` : v
}

/**
 * Анимация — не шиммер, а дыхание. Плашка появляется только если ожидание
 * превысило 180 мс, иначе мигание раздражает сильнее, чем пустота (§11.8).
 */
export function Skeleton({
  variant = 'text',
  width,
  height,
  lines = 1,
  class: cls,
  ...rest
}: SkeletonProps): JSX.Element | null {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), SKELETON_DELAY_MS)
    return () => clearTimeout(t)
  }, [])

  const ref = (el: HTMLElement | null): void => {
    if (el === null) return
    const w = size(width)
    const h = size(height)
    if (w !== undefined) el.style.setProperty('--e-skeleton-w', w)
    if (h !== undefined) el.style.setProperty('--e-skeleton-h', h)
  }

  if (!visible) return null

  const count = variant === 'text' ? Math.max(1, lines) : 1

  return (
    <div
      {...rest}
      ref={ref}
      class={cx('e-skeleton', `e-skeleton--${variant}`, cls)}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, i) => (
        <span class="e-skeleton__bar" key={i} />
      ))}
    </div>
  )
}
