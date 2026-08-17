import type { JSX } from 'preact'
import type { Base, Slot, Tone } from '../../types.js'
import { cx } from '../../utils/cx.js'
import { Button } from '../Button/Button.js'

export interface EmptyStateProps extends Base {
  art?: Slot
  title: string
  description?: string
  action?: { label: string; onAction: () => void }
  size?: 'inline' | 'page'
  tone?: Tone
}

export function EmptyState({
  art,
  title,
  description,
  action,
  size = 'inline',
  tone,
  class: cls,
  ...rest
}: EmptyStateProps): JSX.Element {
  return (
    <div {...rest} class={cx('e-empty', `e-empty--${size}`, cls)} data-tone={tone}>
      {art !== undefined && art !== null ? (
        <div class="e-empty__art" aria-hidden="true">
          {art}
        </div>
      ) : null}
      <p class={cx('e-empty__title', size === 'page' ? 'e-display' : 'e-subhead')}>{title}</p>
      {description !== undefined ? (
        <p class="e-empty__desc e-body-sm">{description}</p>
      ) : null}
      {action !== undefined ? (
        <Button class="e-empty__action" variant="secondary" size="md" onClick={action.onAction}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
