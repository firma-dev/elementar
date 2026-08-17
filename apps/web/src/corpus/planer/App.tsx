import type { JSX } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { EmptyState, Field, IconButton, ListView, Menu, Overlay, Spinner, toast } from '@elementar/ui'
import type { MenuEntry } from '@elementar/ui'
import { AgentProposals, PresenceChip, DigestSheet, peersOf } from '@elementar/shell'
import type { NavItem } from '@elementar/shell'
import { AppShell } from '@elementar/shell'
import { shouldShowDigest } from '@elementar/core'
import type { RecordId } from '@elementar/core'
import { S } from './strings.js'
import { NowScreen } from './screens/Now.js'
import { ListsScreen } from './screens/Lists.js'
import { ProjectsScreen } from './screens/Projects.js'
import { TaskSheet } from './screens/Task.js'
import { Composer } from './components/Composer.js'
import { TaskRow } from './components/TaskRow.js'
import { searchTasks } from './select.js'
import { createStore } from './store.js'
import type { PlanerStore, PlanerTab } from './store.js'
import type { PlanerHandle } from './actions.js'
import { agentAvailable, refreshAgentAvailability } from './agent/available.js'
import { useLazy } from './lazy.js'
import type { Task } from './schema.js'

export interface PlanerAppProps {
  handle: PlanerHandle
  version: string
  installState: 'installed' | 'installable' | 'ios-manual' | 'unsupported'
  onInstall?(): void
  onResetInstall?(): void
}

const NAV: NavItem[] = [
  { id: 'now', label: S.nav.now },
  { id: 'lists', label: S.nav.lists },
  { id: 'projects', label: S.nav.projects },
  { id: 'calendar', label: S.nav.calendar },
]

const SEARCH_ICON = (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="2" />
    <path d="M13 13l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>
)

/** Горячие клавиши десктопа (§12.5). Жест и клавиша всегда дублируют друг друга. */
function useKeyboard(store: PlanerStore): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase()
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) store.doc.undo.redo()
          else store.doc.undo.undo()
        }
        return
      }
      if (typing) return
      switch (e.key) {
        case '/':
          e.preventDefault()
          store.show('search')
          break
        case 't':
          store.tab.value = 'now'
          break
        case 'p':
          store.tab.value = 'projects'
          break
        case 'c':
          store.tab.value = 'calendar'
          break
        case '1':
        case '2':
        case '3':
        case '4': {
          const keys = ['work', 'home', 'hobby', 'craft'] as const
          const next = keys[Number(e.key) - 1]
          if (next !== undefined) {
            store.tab.value = 'lists'
            store.list.value = next
          }
          break
        }
        case 'Escape':
          if (store.taskId.value !== null) store.openTask(null)
          else store.show('none')
          break
        default:
          break
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [store])
}

export function PlanerApp(props: PlanerAppProps): JSX.Element {
  const { handle } = props
  const store = useMemo(() => createStore(handle), [handle])
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [digestSeen, setDigestSeen] = useState(false)
  useKeyboard(store)

  useEffect(() => {
    const tick = (): void => store.refreshToday()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(tick, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [store])

  const overlay = store.overlay.value
  const tab = store.tab.value
  const status = handle.session.status.value
  const proposals = handle.session.proposals.pending.value
  const digest = handle.session.digest.value
  // кнопки агента нет вовсе, если модель не настроена или нет сети (§12.10)
  const agentReady = agentAvailable.value && status.online

  // доступность модели перечитывается при закрытии настроек
  useEffect(() => {
    void refreshAgentAvailability()
  }, [overlay])

  const Calendar = useLazy(() => import('./screens/Calendar.js'), tab === 'calendar')
  const Trash = useLazy(() => import('./screens/Trash.js'), overlay === 'trash')
  const Settings = useLazy(() => import('./screens/Settings.js'), overlay === 'settings')
  const Share = useLazy(() => import('./share.js'), overlay === 'share')
  const Agent = useLazy(() => import('./agent/AgentPanel.js'), overlay === 'agent')

  const peers = peersOf({
    payloads: handle.session.presence.value,
    actors: handle.actors.value,
    me: handle.actor,
  })

  const menuItems: MenuEntry[] = [
    { id: 'share', label: S.share.button, onSelect: () => store.show('share') },
    { id: 'trash', label: S.nav.trash, onSelect: () => store.show('trash') },
    { id: 'settings', label: S.nav.settings, onSelect: () => store.show('settings') },
  ]

  const subtitle =
    status.phase === 'live'
      ? peers.length > 0
        ? S.sync.together
        : undefined
      : status.online
        ? S.sync.syncing
        : S.sync.offline

  return (
    <AppShell
      corpus="planer"
      title={handle.title.value === '' ? S.app.title : handle.title.value}
      subtitle={subtitle}
      nav={NAV}
      navValue={tab}
      onNavChange={(id) => (store.tab.value = id as PlanerTab)}
      presence={peers.length === 0 ? undefined : <PresenceChip peers={peers} />}
      actions={
        <>
          <IconButton label={S.common.search} icon={SEARCH_ICON} onClick={() => store.show('search')} />
          <span ref={setAnchor}>
            <IconButton label={S.common.more} icon="⋯" onClick={() => setMenuOpen(true)} />
          </span>
          <Menu
            items={menuItems}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            anchor={anchor}
            ariaLabel={S.common.more}
          />
        </>
      }
      composer={
        tab === 'calendar' ? undefined : (
          <Composer store={store} onAgent={agentReady ? () => store.show('agent') : undefined} />
        )
      }
    >
      {proposals.length === 0 ? null : (
        <AgentProposals
          proposals={proposals}
          isMine={(p) => p.origin.by === handle.actor}
          isStale={(p) => handle.session.proposals.isStale(p)}
          onAccept={(id: RecordId, only?: number[]) => {
            const count = only?.length ?? handle.session.proposals.get(id)?.changes.length ?? 0
            void handle.session.proposals.accept(id, only).then(() => {
              toast.show({
                message: S.agent.accepted(count),
                tone: 'success',
                action: { label: S.agent.undo, onAction: () => handle.undo.undo() },
              })
            })
          }}
          onReject={(id: RecordId) => {
            void handle.session.proposals.reject(id)
          }}
          onRebase={(id: RecordId) => {
            void handle.session.proposals.rebase(id)
          }}
        />
      )}

      {tab === 'now' ? <NowScreen store={store} /> : null}
      {tab === 'lists' ? <ListsScreen store={store} /> : null}
      {tab === 'projects' ? <ProjectsScreen store={store} /> : null}
      {tab === 'calendar' ? (
        Calendar === null ? (
          <Spinner label={S.common.loading} />
        ) : (
          <Calendar.CalendarScreen store={store} />
        )
      ) : null}

      <TaskSheet store={store} />

      <Overlay
        open={overlay === 'search'}
        title={S.common.search}
        onClose={() => store.show('none')}
        size="md"
      >
        <SearchPanel store={store} />
      </Overlay>

      <Overlay open={overlay === 'trash'} title={S.trash.heading} onClose={() => store.show('none')} size="lg">
        {Trash === null ? <Spinner label={S.common.loading} /> : <Trash.TrashPanel store={store} />}
      </Overlay>

      <Overlay
        open={overlay === 'settings'}
        title={S.settings.heading}
        onClose={() => store.show('none')}
        size="lg"
      >
        {Settings === null ? (
          <Spinner label={S.common.loading} />
        ) : (
          <Settings.SettingsPanel
            store={store}
            version={props.version}
            installState={props.installState}
            {...(props.onInstall === undefined ? {} : { onInstall: props.onInstall })}
            {...(props.onResetInstall === undefined ? {} : { onResetInstall: props.onResetInstall })}
          />
        )}
      </Overlay>

      {Share === null || overlay !== 'share' ? null : (
        <Share.PlanerShareSheet store={store} open onClose={() => store.show('none')} />
      )}

      {Agent === null || overlay !== 'agent' ? null : (
        <Agent.AgentPanel store={store} open onClose={() => store.show('none')} />
      )}

      {digest === null || digestSeen || !shouldShowDigest(digest) ? null : (
        <DigestSheet
          open
          digest={digest}
          onClose={() => setDigestSeen(true)}
          onOpenTrash={() => {
            setDigestSeen(true)
            store.show('trash')
          }}
          nameOf={(actor) => handle.actors.value.find((a) => a.id === actor)?.name ?? 'партнёр'}
        />
      )}
    </AppShell>
  )
}

function SearchPanel({ store }: { store: PlanerStore }): JSX.Element {
  const results = searchTasks(store.doc, store.query.value)
  return (
    <div class="e-stack">
      <Field
        value={store.query.value}
        onValueChange={(v) => (store.query.value = v)}
        ariaLabel={S.common.search}
        placeholder={S.common.searchPlaceholder}
        autoFocus
        clearable
        onEscape={() => store.show('none')}
      />
      {store.query.value.trim() === '' ? null : results.length === 0 ? (
        <EmptyState size="inline" title={S.common.nothingFound} />
      ) : (
        <ListView
          items={results}
          getKey={(t: Task) => t.id}
          ariaLabel={S.common.search}
          renderItem={(t: Task) => <TaskRow task={t} store={store} showDot />}
        />
      )}
    </div>
  )
}

export default PlanerApp
