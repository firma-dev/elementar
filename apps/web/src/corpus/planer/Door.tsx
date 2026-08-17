import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Button, EmptyState, Field, Skeleton } from '@elementar/ui'
import { LinkSaveSheet } from '@elementar/shell'
import { sealAddressBar } from '@elementar/core'
import type { DocId } from '@elementar/proto'
import { DocOpenError, openDocument } from '../../runtime/index.js'
import type { DocHandle, DocOpenReason } from '../../runtime/index.js'
import { PLANER } from './schema.js'
import type { PlanerCollections } from './schema.js'
import { S } from './strings.js'
import { PlanerApp } from './App.js'
import '@elementar/ui/styles.css'
import '@elementar/shell/styles.css'
import './planer.css'

export interface PlanerDoorProps {
  docId: string
  fragment: string | null
  version: string
  installState: 'installed' | 'installable' | 'ios-manual' | 'unsupported'
  onInstall?(): void
  onResetInstall?(): void
  onReady?(handle: DocHandle<PlanerCollections>): void
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; handle: DocHandle<PlanerCollections> }
  | { kind: 'error'; reason: DocOpenReason; message: string }

function messageFor(reason: DocOpenReason): { title: string; hint?: string } {
  switch (reason) {
    case 'need-link':
      return { title: S.errors.needLink, hint: S.errors.needLinkHint }
    case 'need-password':
      return { title: S.errors.needPassword }
    case 'bad-password':
      return { title: S.errors.badPassword }
    case 'network':
      return { title: S.errors.network }
    default:
      return { title: S.errors.notFound }
  }
}

/** Дверь планера: открывает документ по ссылке и показывает честные экраны отказа. */
export function PlanerDoor(props: PlanerDoorProps): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const opened = useRef<DocHandle<PlanerCollections> | null>(null)
  const [password, setPassword] = useState('')
  const [askSave, setAskSave] = useState(false)

  const open = (pw?: string): void => {
    setState({ kind: 'loading' })
    const ref = props.fragment === null ? props.docId : `${props.docId}#${props.fragment}`
    void openDocument<PlanerCollections>(PLANER, ref, pw === undefined ? {} : { password: pw })
      .then((handle) => {
        opened.current = handle
        setState({ kind: 'ready', handle })
        props.onReady?.(handle)
        if (props.fragment !== null && !handle.linkSaved) setAskSave(true)
        else if (props.fragment !== null) sealAddressBar(props.docId as DocId)
      })
      .catch((e: unknown) => {
        if (e instanceof DocOpenError) setState({ kind: 'error', reason: e.reason, message: e.message })
        else setState({ kind: 'error', reason: 'network', message: String(e) })
      })
  }

  useEffect(() => {
    open()
    return () => {
      const handle = opened.current
      opened.current = null
      if (handle !== null) void handle.close()
    }
    // документ переоткрывается только при смене адреса
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docId, props.fragment])

  if (state.kind === 'loading')
    return (
      <div class="p-boot e-stack">
        <Skeleton variant="row" lines={6} />
      </div>
    )

  if (state.kind === 'error') {
    const text = messageFor(state.reason)
    const needsPassword = state.reason === 'need-password' || state.reason === 'bad-password'
    return (
      <div class="p-boot e-content e-stack">
        <EmptyState size="page" title={text.title} description={text.hint ?? state.message} />
        {needsPassword ? (
          <div class="e-stack">
            <Field
              value={password}
              onValueChange={setPassword}
              ariaLabel={S.errors.passwordPlaceholder}
              placeholder={S.errors.passwordPlaceholder}
              autoFocus
              onEnter={() => open(password)}
            />
            <Button variant="primary" onClick={() => open(password)}>
              {S.errors.openAction}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <PlanerApp
        handle={state.handle}
        version={props.version}
        installState={props.installState}
        {...(props.onInstall === undefined ? {} : { onInstall: props.onInstall })}
        {...(props.onResetInstall === undefined ? {} : { onResetInstall: props.onResetInstall })}
      />
      <LinkSaveSheet
        open={askSave}
        link={state.handle.link}
        title={S.share.title}
        onClose={() => setAskSave(false)}
        onSaved={() => {
          void state.handle.markLinkSaved()
          setAskSave(false)
          sealAddressBar(props.docId as DocId)
        }}
      />
    </>
  )
}

export default PlanerDoor
