import type { JSX } from 'preact'
import type { Slot } from '../../types.js'
import type { ButtonProps } from '../Button/Button.js'
import { cx } from '../../utils/cx.js'
import { Spinner } from '../Spinner/Spinner.js'

export interface IconButtonProps
  extends Omit<ButtonProps, 'iconStart' | 'iconEnd' | 'fullWidth'> {
  /** Обязателен: aria-label и подсказка на десктопе. Без него кнопка не проходит типизацию. */
  label: string
  icon: Slot
  shape?: 'square' | 'round'
}

/** Визуальный размер иконки 20px, зона нажатия расширяется до 44px псевдоэлементом. */
export function IconButton({
  label,
  icon,
  shape = 'square',
  variant = 'ghost',
  size = 'md',
  loading = false,
  disabled = false,
  tone,
  type = 'button',
  class: cls,
  children: _children,
  ...rest
}: IconButtonProps): JSX.Element {
  const onSolid = variant === 'primary' || variant === 'danger'
  return (
    <button
      {...rest}
      type={type}
      class={cx(
        'e-btn',
        'e-iconbtn',
        `e-btn--${variant}`,
        `e-iconbtn--${size}`,
        `e-iconbtn--${shape}`,
        onSolid && 'e-on-solid',
        cls,
      )}
      data-tone={tone}
      data-tap={size}
      title={label}
      aria-label={label}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
    >
      <span class="e-iconbtn__icon">
        {loading ? <Spinner size={size === 'sm' ? 16 : 20} /> : icon}
      </span>
    </button>
  )
}
