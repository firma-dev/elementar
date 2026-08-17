/**
 * Preact-биндинги ядра (§7.7 «Preact-биндинги»).
 *
 * Настоящего единого `DocHandle` (документ + синк + крипта) в ядре пока нет — его собирает
 * приложение поверх `DocCore` (см. `apps/web/src/runtime/doc.ts`). Биндинги поэтому работают
 * с `DocCore` напрямую, а сетевые хуки (`useSyncStatus`, `useProposals`) читают необязательное
 * поле `session`, которое такой сборный хендл добавляет структурно — без импорта из apps/web.
 *
 * Реактивность без `@preact/signals`: у ядра в зависимостях только `@preact/signals-core`,
 * поэтому подписка на сигнал ведётся вручную через `useState`/`useEffect` (preact/hooks).
 */
import { createContext, h } from 'preact'
import type { ComponentChildren, VNode } from 'preact'
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks'
import { signal } from '@preact/signals-core'
import type { ReadonlySignal } from '@preact/signals-core'
import type { Collection } from './doc/view.js'
import type { DocCore } from './doc/handle.js'
import type { Tx, TxResult } from './doc/tx.js'
import type { RecordId } from './id.js'
import type { CollectionsDef, RecordOf } from './schema/types.js'
import type { Proposal } from './proposals/types.js'
import type { Session } from './sync/session.js'
import type { SyncStatus } from './sync/machine.js'

/** Документ с необязательной сетевой сессией — именно столько нужно этим биндингам. */
export interface DocWithSession<S extends CollectionsDef> extends DocCore<S> {
  readonly session?: Session
}

const NO_SYNC_STATUS: SyncStatus = {
  phase: 'local',
  online: false,
  pending: 0,
  lastSyncedAt: null,
  peers: 0,
  retryInMs: null,
  chainWarning: false,
  error: null,
}

const NO_PROPOSALS: readonly Proposal[] = []

// Стабильные сигналы-заглушки для документа без сессии синка: число хуков в компоненте
// должно быть неизменным между рендерами, поэтому useSignalValue вызывается всегда,
// а не только когда `doc.session` есть.
const NO_SYNC_STATUS_SIGNAL: ReadonlySignal<SyncStatus> = signal(NO_SYNC_STATUS)
const NO_PROPOSALS_SIGNAL: ReadonlySignal<readonly Proposal[]> = signal(NO_PROPOSALS)

const DocContext = createContext<DocWithSession<CollectionsDef> | null>(null)

export interface DocProviderProps<S extends CollectionsDef> {
  doc: DocWithSession<S>
  children: ComponentChildren
}

export function DocProvider<S extends CollectionsDef>(props: DocProviderProps<S>): VNode {
  const value = props.doc as unknown as DocWithSession<CollectionsDef>
  // Provider типизирован конкретным value: узел неизбежно параметризован иначе, чем VNode<{}>.
  return h(DocContext.Provider, { value }, props.children) as unknown as VNode
}

function useDocErased(): DocWithSession<CollectionsDef> {
  const doc = useContext(DocContext)
  if (doc === null) throw new Error('useDoc/useCollection/useTx вызваны без <DocProvider>')
  return doc
}

/**
 * Подписка на сигнал через ре-рендер компонента: `signal.subscribe` вызывает колбэк сразу
 * при подписке — сравниваем со сохранённым значением, чтобы не дёргать лишний ре-рендер.
 */
function useSignalValue<T>(sig: ReadonlySignal<T>): T {
  const [value, setValue] = useState(sig.value)
  useEffect(() => {
    setValue(sig.value)
    return sig.subscribe((next) => {
      setValue(next)
    })
  }, [sig])
  return value
}

export function useDoc<S extends CollectionsDef>(): DocCore<S> {
  return useDocErased() as unknown as DocCore<S>
}

export function useCollection<S extends CollectionsDef, K extends keyof S & string>(
  name: K,
): Collection<RecordOf<S[K]>> {
  const doc = useDoc<S>()
  return doc.col[name]
}

export function useQuery<T>(sig: ReadonlySignal<readonly T[]>): readonly T[] {
  return useSignalValue(sig)
}

/** `byId` не кеширует сигнал (в отличие от `where`/`group`) — фиксируем его через useMemo. */
export function useRecord<T>(collection: string, id: RecordId): T | undefined {
  const doc = useDocErased()
  const col = doc.col[collection]
  if (col === undefined) throw new Error(`неизвестная коллекция «${collection}»`)
  const sig = useMemo(() => col.byId(id), [col, id])
  return useSignalValue(sig) as T | undefined
}

export function useSyncStatus(): SyncStatus {
  const doc = useDocErased()
  return useSignalValue(doc.session?.status ?? NO_SYNC_STATUS_SIGNAL)
}

export function useProposals(): readonly Proposal[] {
  const doc = useDocErased()
  return useSignalValue(doc.session?.proposals.pending ?? NO_PROPOSALS_SIGNAL)
}

export function useTx<S extends CollectionsDef>(): (
  fn: (t: Tx<S>) => void,
  opts?: { label?: string },
) => TxResult {
  const doc = useDoc<S>()
  return useCallback((fn, opts) => doc.tx(fn, opts), [doc])
}

// usePwa живёт в pwa.ts (там же регистрация сервис-воркера) — здесь только реэкспорт.
export { usePwa } from './pwa.js'
export type { PwaState } from './pwa.js'
