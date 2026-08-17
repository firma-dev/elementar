/**
 * Присутствие в шапке (§12.9): до двух аватаров 24px.
 * Онлайн — полная насыщенность и точка успеха; офлайн — приглушённый аватар
 * и подпись «был час назад». Никаких живых курсоров и счётчика «онлайн 2».
 */
import type { JSX } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { Avatar, Overlay, cx, useBreakpointUp } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import { formatLastSeen } from '../../text.js'
import type { PresencePeer } from './presence.js'

export interface PresenceChipProps extends Base {
  peers: readonly PresencePeer[]
  /** Больше двух не показываем: парный режим (§12.9). */
  max?: number
  now?: number
}

export function PresenceChip({
  peers,
  max = 2,
  now,
  class: cls,
  ...rest
}: PresenceChipProps): JSX.Element | null {
  const wide = useBreakpointUp('md')
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const shown = peers.slice(0, max)
  if (shown.length === 0) return null

  const title = (p: PresencePeer): string =>
    p.online ? `${p.name}${p.where !== undefined ? ` · ${p.where}` : ''}` : `${p.name} · ${formatLastSeen(p.lastSeenAt, now)}`

  if (wide) {
    return (
      <div {...rest} class={cx('e-presence', cls)}>
        {shown.map((p) => (
          <div key={p.actor} class={cx('e-presence__item', !p.online && 'is-offline')}>
            <Avatar
              name={p.name}
              color={p.slot}
              size={24}
              presence={p.online ? 'here' : 'offline'}
              title={title(p)}
            />
            <span class="e-presence__where e-caption e-truncate">
              {p.online ? (p.where ?? 'здесь') : formatLastSeen(p.lastSeenAt, now)}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      <button
        {...rest}
        ref={anchorRef}
        type="button"
        class={cx('e-presence e-presence--compact', cls)}
        aria-label="Кто ещё в документе"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {shown.map((p) => (
          <span key={p.actor} class={cx('e-presence__item', !p.online && 'is-offline')}>
            <Avatar
              name={p.name}
              color={p.slot}
              size={24}
              presence={p.online ? 'here' : 'offline'}
              title={title(p)}
            />
          </span>
        ))}
      </button>
      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        presentation="popover"
        anchor={anchorRef.current}
        size="sm"
        title="В документе"
      >
        <ul class="e-presence__list">
          {shown.map((p) => (
            <li key={p.actor} class="e-presence__row">
              <Avatar name={p.name} color={p.slot} size={24} presence={p.online ? 'here' : 'offline'} />
              <span class="e-body">{p.name}</span>
              <span class="e-caption e-presence__where">
                {p.online ? (p.where ?? 'здесь') : formatLastSeen(p.lastSeenAt, now)}
              </span>
            </li>
          ))}
        </ul>
      </Overlay>
    </>
  )
}
