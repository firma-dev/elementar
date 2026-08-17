import type { JSX } from 'preact'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface ChipProps extends Base {
  label: string
  tone?: Tone
  icon?: Slot
  selected?: boolean
  onSelect?: () => void
  onRemove?: () => void
  size?: 'sm' | 'md'
}

/**
 * Текст чипа всегда --e-fg: тон отвечает за подложку и точку, но не за текст —
 * тон на своём тинте не всегда даёт 4.5:1 (например success в светлой теме).
 */
export function Chip({
  label,
  tone,
  icon,
  selected = false,
  onSelect,
  onRemove,
  size = 'md',
  class: cls,
  ...rest
}: ChipProps): JSX.Element {
  const interactive = onSelect !== undefined
  const cn = cx(
    'e-chip',
    `e-chip--${size}`,
    selected && 'e-chip--selected',
    tone !== undefined && 'e-chip--toned',
    cls,
  )

  const inner = (
    <>
      {icon !== undefined && icon !== null ? (
        <span class="e-chip__icon" aria-hidden="true">
          {icon}
        </span>
      ) : tone !== undefined ? (
        <span class="e-chip__dot" aria-hidden="true" />
      ) : null}
      <span class="e-chip__label">{label}</span>
    </>
  )

  return (
    <span {...rest} class={cn} data-tone={tone}>
      {interactive ? (
        <button
          type="button"
          class="e-chip__main"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {inner}
        </button>
      ) : (
        <span class="e-chip__main">{inner}</span>
      )}
      {onRemove !== undefined ? (
        <button
          type="button"
          class="e-chip__remove"
          aria-label={`Убрать: ${label}`}
          onClick={onRemove}
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
      ) : null}
    </span>
  )
}
