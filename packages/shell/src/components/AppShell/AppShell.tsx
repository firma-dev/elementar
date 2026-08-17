/**
 * Оболочка приложения (§11.9): TopBar + контент + (TabBar | Rail),
 * safe-area и data-corpus на корне. Знает про документы — потому не в `ui`.
 */
import type { JSX } from 'preact'
import { useBreakpointUp, ToastViewport, cx } from '@elementar/ui'
import type { Base, Slot, Tone } from '@elementar/ui'
import { TopBar } from './TopBar.js'
import { TabBar } from './TabBar.js'
import { Rail } from './Rail.js'
import type { NavItem } from './nav.js'

export interface AppShellProps extends Base {
  /** Корпус документа: 'planer' | 'finanser' — уходит в data-corpus. */
  corpus: string
  title: Slot
  subtitle?: Slot
  /** Кнопка «назад» или логотип. */
  leading?: Slot
  /** До двух действий справа в шапке. */
  actions?: Slot
  /** Слот присутствия: сюда ставится PresenceChip. */
  presence?: Slot
  nav?: readonly NavItem[]
  navValue?: string
  onNavChange?: (id: string) => void
  tone?: Tone
  /** Прилипший низ: композер планера. */
  composer?: Slot
  /** Тосты монтируются один раз — здесь. */
  toasts?: boolean
  children: Slot
}

export function AppShell({
  corpus,
  title,
  subtitle,
  leading,
  actions,
  presence,
  nav,
  navValue,
  onNavChange,
  tone,
  composer,
  toasts = true,
  children,
  class: cls,
  ...rest
}: AppShellProps): JSX.Element {
  const wide = useBreakpointUp('lg')
  const items = nav ?? []
  const showRail = wide && items.length > 0
  const showTabBar = !wide && items.length > 0
  const change = (id: string): void => onNavChange?.(id)

  return (
    <div
      {...rest}
      class={cx('e-shell', showRail && 'e-shell--rail', showTabBar && 'e-shell--tabbar', cls)}
      data-corpus={corpus}
      data-tone={tone}
    >
      <a class="e-skip-link" href="#e-shell-main">
        Перейти к содержимому
      </a>
      {showRail ? (
        <Rail items={items} value={navValue} onChange={change} ariaLabel="Разделы" />
      ) : null}
      <div class="e-shell__column">
        <TopBar title={title} subtitle={subtitle} leading={leading} actions={actions} presence={presence} />
        <main id="e-shell-main" class="e-shell__main">
          <div class="e-content">{children}</div>
        </main>
        {composer !== undefined && composer !== null ? (
          <div class="e-shell__composer e-safe-bottom">{composer}</div>
        ) : null}
      </div>
      {showTabBar ? (
        <TabBar items={items} value={navValue} onChange={change} ariaLabel="Разделы" />
      ) : null}
      {toasts ? <ToastViewport withTabBar={showTabBar} /> : null}
    </div>
  )
}
