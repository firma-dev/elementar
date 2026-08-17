import type { JSX } from 'preact'
import type { Base } from '../../types.js'
import { cx } from '../../utils/cx.js'

export interface AvatarProps extends Base {
  name: string
  color: 'a' | 'b' | 'agent'
  size?: 16 | 20 | 24 | 32
  presence?: 'here' | 'away' | 'offline'
  title?: string
}

/** Инициалы: первая буква первого слова и первая буква второго, если оно есть. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '')
  const first = parts[0]
  if (first === undefined) return '?'
  const second = parts[1]
  const a = [...first][0] ?? '?'
  const b = second !== undefined ? ([...second][0] ?? '') : ''
  return (a + b).toLocaleUpperCase('ru-RU')
}

/** Появление партнёра скринридером не объявляется — это шум (§11.7). */
export function Avatar({
  name,
  color,
  size = 24,
  presence,
  title,
  class: cls,
  ...rest
}: AvatarProps): JSX.Element {
  return (
    <span
      {...rest}
      class={cx('e-avatar', cls)}
      data-color={color}
      data-size={size}
      data-presence={presence}
      title={title ?? name}
      role="img"
      aria-label={name}
    >
      <span class="e-avatar__initials" aria-hidden="true">
        {initials(name)}
      </span>
      {presence !== undefined ? <span class="e-avatar__presence" aria-hidden="true" /> : null}
    </span>
  )
}
