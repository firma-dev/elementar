import type { JSX } from 'preact'
import { useEffect, useId, useRef } from 'preact/hooks'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface CheckboxProps extends Base {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: Slot
  ariaLabel?: string
  description?: Slot
  indeterminate?: boolean
  disabled?: boolean
  tone?: Tone
  /** Визуально 20 / 24, зона нажатия всегда 44. */
  size?: 'md' | 'lg'
}

/**
 * Нативный input визуально скрыт, квадрат рисуется рядом. Галочка — stroke-dasharray
 * 0→24 за 130 мс с --e-ease-snap; при снятии исчезает мгновенно (§11.8).
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  ariaLabel,
  description,
  indeterminate = false,
  disabled = false,
  tone,
  size = 'md',
  class: cls,
  id,
  ...rest
}: CheckboxProps): JSX.Element {
  const auto = useId()
  const inputId = id ?? `e-checkbox-${auto}`
  const descId = `${inputId}-desc`
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <div
      {...rest}
      class={cx('e-checkbox', `e-checkbox--${size}`, disabled && 'e-checkbox--disabled', cls)}
      data-tone={tone}
    >
      <input
        ref={ref}
        id={inputId}
        class="e-checkbox__input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label === undefined ? ariaLabel : undefined}
        aria-describedby={description !== undefined && description !== null ? descId : undefined}
        aria-checked={indeterminate ? 'mixed' : checked}
        onChange={(e) => onCheckedChange(e.currentTarget.checked)}
      />
      <label class="e-checkbox__box" for={inputId} aria-hidden="true">
        <svg viewBox="0 0 24 24" class="e-checkbox__mark" focusable="false">
          <path
            class="e-checkbox__tick"
            d="M5 12.5l4.5 4.5L19 7"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            pathLength="24"
          />
          <path
            class="e-checkbox__dash"
            d="M6 12h12"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
          />
        </svg>
      </label>
      {label !== undefined && label !== null ? (
        <div class="e-checkbox__text">
          <label class="e-checkbox__label e-body" for={inputId}>
            {label}
          </label>
          {description !== undefined && description !== null ? (
            <div class="e-checkbox__desc e-body-sm" id={descId}>
              {description}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
