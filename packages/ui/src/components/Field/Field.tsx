import type { JSX, Ref } from 'preact'
import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import type { Base, Slot } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { IconButton } from '../IconButton/IconButton.js'

export interface FieldProps extends Base {
  value: string
  onValueChange: (value: string) => void
  label?: string
  ariaLabel?: string
  placeholder?: string
  hint?: string
  error?: string
  size?: 'md' | 'lg'
  multiline?: boolean | { minRows?: number; maxRows?: number }
  clearable?: boolean
  prefix?: Slot
  suffix?: Slot
  disabled?: boolean
  readOnly?: boolean
  required?: boolean
  autoFocus?: boolean
  maxLength?: number
  inputMode?: JSX.HTMLAttributes<HTMLInputElement>['inputMode']
  enterKeyHint?: 'done' | 'go' | 'next' | 'send'
  autoCapitalize?: 'none' | 'sentences'
  spellcheck?: boolean
  onEnter?: (value: string) => void
  onEscape?: () => void
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>
}

const CLEAR_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path
      d="M6 6l8 8M14 6l-8 8"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
  </svg>
)

/**
 * font-size: 16px всегда — иначе iOS Safari зумит страницу при фокусе.
 * Авторост textarea — через скрытый measurer (::after у обёртки), а не scrollHeight в rAF.
 */
export function Field({
  value,
  onValueChange,
  label,
  ariaLabel,
  placeholder,
  hint,
  error,
  size = 'md',
  multiline = false,
  clearable = false,
  prefix,
  suffix,
  disabled = false,
  readOnly = false,
  required = false,
  autoFocus = false,
  maxLength,
  inputMode,
  enterKeyHint,
  autoCapitalize,
  spellcheck,
  onEnter,
  onEscape,
  inputRef,
  class: cls,
  id,
  ...rest
}: FieldProps): JSX.Element {
  const growRef = useRef<HTMLDivElement>(null)
  const auto = useId()
  const inputId = id ?? `e-field-${auto}`
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const invalid = error !== undefined && error !== ''

  const rows = typeof multiline === 'object' ? multiline : {}
  const isMultiline = multiline !== false
  const minRows = rows.minRows ?? 2
  const maxRows = rows.maxRows ?? 10

  const describedBy =
    [invalid ? errorId : null, hint !== undefined && hint !== '' ? hintId : null]
      .filter((x): x is string => x !== null)
      .join(' ') || undefined

  const onInput = (
    e: JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement, Event>,
  ): void => {
    onValueChange(e.currentTarget.value)
  }

  const onKeyDown = (
    e: JSX.TargetedKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void => {
    if (e.key === 'Escape' && onEscape !== undefined) {
      e.stopPropagation()
      onEscape()
      return
    }
    if (e.key !== 'Enter' || onEnter === undefined) return
    // В многострочном поле Enter вводит перевод строки, отправка — Cmd/Ctrl+Enter.
    if (isMultiline && !(e.metaKey || e.ctrlKey)) return
    if (!isMultiline && (e.shiftKey || e.isComposing)) return
    e.preventDefault()
    onEnter(e.currentTarget.value)
  }

  // Границы авторо́ста задаются переменными, а не инлайновым стилем размера.
  useLayoutEffect(() => {
    const el = growRef.current
    if (el === null) return
    el.style.setProperty('--e-rows-min', String(minRows))
    el.style.setProperty('--e-rows-max', String(maxRows))
  }, [minRows, maxRows])

  const showClear = clearable && value !== '' && !disabled && !readOnly

  const shared = {
    id: inputId,
    class: 'e-field__input',
    value,
    placeholder,
    disabled,
    readOnly,
    required,
    autoFocus,
    maxLength,
    inputMode,
    enterKeyHint,
    autocapitalize: autoCapitalize,
    spellcheck,
    'aria-label': label === undefined ? ariaLabel : undefined,
    'aria-invalid': invalid ? ('true' as const) : undefined,
    'aria-describedby': describedBy,
    'aria-errormessage': invalid ? errorId : undefined,
    onInput,
    onKeyDown,
  }

  return (
    <div
      {...rest}
      class={cx('e-field', `e-field--${size}`, invalid && 'e-field--invalid', disabled && 'e-field--disabled', cls)}
    >
      {label !== undefined ? (
        <label class="e-field__label e-caption" for={inputId}>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </label>
      ) : null}

      <div class="e-field__control">
        {prefix !== undefined && prefix !== null ? (
          <span class="e-field__affix">{prefix}</span>
        ) : null}

        {isMultiline ? (
          <div class="e-field__grow" ref={growRef} data-value={value}>
            <textarea
              {...shared}
              ref={inputRef as Ref<HTMLTextAreaElement> | undefined}
              rows={minRows}
            />
          </div>
        ) : (
          <input {...shared} type="text" ref={inputRef as Ref<HTMLInputElement> | undefined} />
        )}

        {showClear ? (
          <IconButton
            class="e-field__clear"
            label="Очистить"
            size="sm"
            variant="ghost"
            icon={CLEAR_ICON}
            onClick={() => onValueChange('')}
          />
        ) : null}

        {suffix !== undefined && suffix !== null ? (
          <span class="e-field__affix">{suffix}</span>
        ) : null}
      </div>

      {invalid ? (
        <p class="e-field__error e-body-sm" id={errorId} role="alert">
          {error}
        </p>
      ) : hint !== undefined && hint !== '' ? (
        <p class="e-field__hint e-body-sm" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}
