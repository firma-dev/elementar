/**
 * Шит агента «Что нужно сделать?» (§12.10). Одна кнопка, без меню промптов.
 * Пока модель думает — три скелетон-строки в тоне агента и «Отменить».
 */
import type { JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import { Button, Chip, Field, Overlay, Skeleton, cx } from '@elementar/ui'
import type { Base, OverlayCloseReason } from '@elementar/ui'

export interface AgentSheetProps extends Base {
  open: boolean
  onClose: (reason: OverlayCloseReason) => void
  title?: string
  /** Примеры серым: подсказка формы запроса, а не меню. */
  examples?: readonly string[]
  running?: boolean
  /** «Показать агенту весь планер» — явная галочка, не по умолчанию (§10.4). */
  whole?: boolean
  onWholeChange?: (whole: boolean) => void
  onSubmit: (request: string) => void | Promise<void>
  onCancel?: () => void
  error?: string | null
}

export function AgentSheet({
  open,
  onClose,
  title = 'Что нужно сделать?',
  examples = ['разложить переезд на задачи', 'разобрать список покупок по магазинам'],
  running = false,
  whole,
  onWholeChange,
  onSubmit,
  onCancel,
  error,
  class: cls,
  ...rest
}: AgentSheetProps): JSX.Element {
  const [text, setText] = useState('')

  const submit = useCallback(() => {
    const request = text.trim()
    if (request === '') return
    void onSubmit(request)
  }, [onSubmit, text])

  return (
    <Overlay
      {...rest}
      class={cx('e-agent-sheet', cls)}
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      data-tone="agent"
    >
      {running ? (
        <div class="e-agent-sheet__running">
          <Skeleton variant="row" />
          <Skeleton variant="row" />
          <Skeleton variant="row" />
          <Button variant="ghost" fullWidth onClick={() => onCancel?.()}>
            Отменить
          </Button>
        </div>
      ) : (
        <>
          <Field
            ariaLabel={title}
            value={text}
            onValueChange={setText}
            multiline={{ minRows: 3, maxRows: 8 }}
            placeholder="Например: собрать переезд в задачи по неделям"
            autoFocus
            onEnter={submit}
          />
          <div class="e-agent-sheet__examples">
            {examples.map((e) => (
              <Chip key={e} label={e} size="sm" tone="agent" onSelect={() => setText(e)} />
            ))}
          </div>
          {onWholeChange !== undefined ? (
            <label class="e-agent-sheet__whole e-body-sm">
              <input
                type="checkbox"
                checked={whole === true}
                onChange={(ev) => onWholeChange((ev.currentTarget as HTMLInputElement).checked)}
              />
              Показать агенту весь планер
            </label>
          ) : null}
          {error !== undefined && error !== null ? (
            <p class="e-body-sm e-agent-sheet__error" role="status">
              {error}
            </p>
          ) : null}
          <Button variant="primary" fullWidth tone="agent" disabled={text.trim() === ''} onClick={submit}>
            Предложить
          </Button>
        </>
      )}
    </Overlay>
  )
}

export interface AgentButtonProps extends Base {
  onClick: () => void
  label?: string
  /** Слот пуст или сети нет — кнопки нет вовсе (§12.10). */
  available: boolean
}

export function AgentButton({ onClick, label = 'Спросить агента', available, class: cls, ...rest }: AgentButtonProps): JSX.Element | null {
  if (!available) return null
  return (
    <Button
      {...rest}
      class={cx('e-agent-button', cls)}
      variant="ghost"
      tone="agent"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      ✧
    </Button>
  )
}
