import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Button, Spinner, ToastViewport } from '@elementar/ui'
import { RecoveryScreen } from '@elementar/shell'
import { Hall } from './shell/Hall.js'
import { NotFound } from './shell/NotFound.js'
import { H } from './shell/strings.js'
import { LAST_DOC_ALIAS, currentRoute, navigate } from './routes.js'
import { keysToPath, linkToPath } from './shell/link.js'
import type { DocRoute } from './routes.js'
import { lastDocOf } from './runtime/db.js'
import type { PwaState } from './pwa.js'

interface DoorModule {
  PlanerDoor: (p: {
    docId: string
    fragment: string | null
    version: string
    installState: PwaState['installState']['value']
    onInstall?(): void
    onResetInstall?(): void
    onReady?(handle: { session: { flush(): Promise<void>; snapshot(): Promise<void> } }): void
  }) => JSX.Element
}

function useDoor(corpus: string): DoorModule | 'finanser' | null {
  const [mod, setMod] = useState<DoorModule | 'finanser' | null>(null)
  useEffect(() => {
    let alive = true
    if (corpus === 'finanser') {
      setMod('finanser')
      return
    }
    void import('./corpus/planer/index.js').then((m) => {
      if (alive) setMod({ PlanerDoor: m.PlanerDoor as unknown as DoorModule['PlanerDoor'] })
    })
    return () => {
      alive = false
    }
  }, [corpus])
  return mod
}

function DocScreen({ route, pwa }: { route: DocRoute; pwa: PwaState }): JSX.Element {
  const door = useDoor(route.corpus)
  const [resolved, setResolved] = useState<string | null>(
    route.docId === LAST_DOC_ALIAS ? null : route.docId,
  )

  useEffect(() => {
    if (route.docId !== LAST_DOC_ALIAS) {
      setResolved(route.docId)
      return
    }
    void lastDocOf(route.corpus).then((card) => {
      if (card === undefined) navigate('/', { replace: true })
      else navigate(`${route.prefix}/${card.docId}`, { replace: true })
    })
  }, [route.docId, route.corpus, route.prefix])

  if (door === null || resolved === null) return <Spinner label={H.hall.docs} />
  if (door === 'finanser') return <FinanserLazy />

  return (
    <door.PlanerDoor
      docId={resolved}
      fragment={route.fragment}
      version={pwa.version}
      installState={pwa.installState.value}
      onInstall={() => void pwa.promptInstall()}
      onResetInstall={() => void pwa.resetInstall()}
      onReady={(handle) => {
        pwa.setBeforeApply(async () => {
          await handle.session.flush()
          await handle.session.snapshot()
        })
      }}
    />
  )
}

function FinanserLazy(): JSX.Element {
  const [mod, setMod] = useState<{ FinanserDoor: () => JSX.Element } | null>(null)
  useEffect(() => {
    void import('./corpus/finanser/index.js').then(setMod)
  }, [])
  return mod === null ? <Spinner label={H.finanser.title} /> : <mod.FinanserDoor />
}

function InviteLazy({ iid }: { iid: string }): JSX.Element {
  const [mod, setMod] = useState<{ InviteScreen: (p: { iid: string }) => JSX.Element } | null>(null)
  useEffect(() => {
    void import('./shell/Invite.js').then(setMod)
  }, [])
  return mod === null ? <Spinner label={H.invite.title} /> : <mod.InviteScreen iid={iid} />
}

/** Приём расшаренной ссылки (`share_target` манифеста, §13.1). */
function ShareScreen({ url, text }: { url: string | null; text: string | null }): JSX.Element {
  useEffect(() => {
    void linkToPath(url ?? text ?? '').then((path) => {
      navigate(path ?? '/', { replace: true })
    })
  }, [url, text])
  return <Spinner label={H.share.title} />
}

function UpdateBar({ pwa }: { pwa: PwaState }): JSX.Element | null {
  if (!pwa.updateReady.value) return null
  return (
    <div class="h-update e-safe-bottom" role="status">
      <span class="e-body-sm">{H.update.ready}</span>
      <Button size="sm" variant="primary" onClick={() => void pwa.applyUpdate()}>
        {H.update.apply}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => pwa.dismissUpdate()}>
        {H.update.later}
      </Button>
    </div>
  )
}

export function App({ pwa }: { pwa: PwaState }): JSX.Element {
  const route = currentRoute.value

  return (
    <>
      {route.kind === 'hall' ? <Hall /> : null}
      {route.kind === 'doc' ? <DocScreen route={route} pwa={pwa} /> : null}
      {route.kind === 'invite' ? <InviteLazy iid={route.iid} /> : null}
      {route.kind === 'share' ? <ShareScreen url={route.url} text={route.text} /> : null}
      {route.kind === 'recovery' ? (
        <main class="h-hall e-content">
          <RecoveryScreen
            title={H.recovery.title}
            onCancel={() => navigate('/')}
            onRecovered={async (link) => {
              navigate(await keysToPath(link.docId, link.linkSecret), { replace: true })
            }}
          />
        </main>
      ) : null}
      {route.kind === 'notFound' ? <NotFound path={route.path} /> : null}
      <UpdateBar pwa={pwa} />
      {route.kind === 'doc' ? null : <ToastViewport />}
    </>
  )
}
