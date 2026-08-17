import type { JSX } from 'preact'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { Spinner } from '../Spinner/Spinner.js'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps
  extends Base,
    Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'size' | 'class' | 'id' | 'loading'> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Спиннер вместо iconStart, ширина не меняется, aria-busy. */
  loading?: boolean
  disabled?: boolean
  iconStart?: Slot
  iconEnd?: Slot
  tone?: Tone
  type?: 'button' | 'submit'
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>
}

/**
 * Геометрия: sm 32/14 (только десктоп), md 44/16, lg 52/16 medium.
 * sm запрещён как единственная тач-цель — это проверяется по data-tap.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  iconStart,
  iconEnd,
  tone,
  type = 'button',
  class: cls,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const spinnerSize = size === 'sm' ? 16 : 20
  const onSolid = variant === 'primary' || variant === 'danger'
  // Спиннер занимает место iconStart; если его нет — перекрывает подпись,
  // подпись прячется через visibility, поэтому ширина кнопки не меняется.
  const spinnerInPlaceOfIcon = loading && iconStart !== undefined && iconStart !== null

  return (
    <button
      {...rest}
      type={type}
      class={cx(
        'e-btn',
        `e-btn--${variant}`,
        `e-btn--${size}`,
        fullWidth && 'e-btn--full',
        loading && 'e-btn--loading',
        loading && !spinnerInPlaceOfIcon && 'e-btn--loading-overlay',
        onSolid && 'e-on-solid',
        cls,
      )}
      data-tone={tone}
      data-tap={size}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
    >
      {spinnerInPlaceOfIcon ? (
        <span class="e-btn__icon">
          <Spinner size={spinnerSize} />
        </span>
      ) : iconStart !== undefined && iconStart !== null ? (
        <span class="e-btn__icon">{iconStart}</span>
      ) : null}
      <span class="e-btn__label">{children}</span>
      {iconEnd !== undefined && iconEnd !== null ? (
        <span class="e-btn__icon">{iconEnd}</span>
      ) : null}
      {loading && !spinnerInPlaceOfIcon ? (
        <span class="e-btn__overlay">
          <Spinner size={spinnerSize} />
        </span>
      ) : null}
    </button>
  )
}
