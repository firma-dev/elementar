import { signal } from '@preact/signals'
import type { ReadonlySignal } from '@preact/signals'
import { APP_PREFIX } from '@elementar/proto'
import { isDocId, isFragment } from '@elementar/proto'

export type CorpusId = 'planer' | 'finanser'

export interface DocRoute {
  kind: 'doc'
  corpus: CorpusId
  prefix: string
  docId: string
  /** Фрагмент со ссылочным секретом, если он есть в адресе. */
  fragment: string | null
  /** Запрос: ?new=1, ?view=today, ?d=1. */
  query: URLSearchParams
}

export type Route =
  | { kind: 'hall' }
  | DocRoute
  | { kind: 'invite'; iid: string }
  | { kind: 'share'; url: string | null; text: string | null }
  | { kind: 'recovery' }
  | { kind: 'notFound'; path: string }

const CORPUS_BY_PREFIX: Record<string, CorpusId> = {
  [APP_PREFIX.planer]: 'planer',
  [APP_PREFIX.finanser]: 'finanser',
}

/** Последний открытый документ корпуса: цель ярлыков манифеста `/p/last`. */
export const LAST_DOC_ALIAS = 'last'

export function parseRoute(url: URL): Route {
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/') return { kind: 'hall' }
  if (path === '/share')
    return { kind: 'share', url: url.searchParams.get('url'), text: url.searchParams.get('text') }
  if (path === '/recovery') return { kind: 'recovery' }

  const parts = path.split('/').filter((p) => p !== '')
  const head = parts[0]
  const tail = parts[1]
  if (head === undefined) return { kind: 'hall' }

  if (head === 'i' && tail !== undefined) return { kind: 'invite', iid: tail }

  const corpus = CORPUS_BY_PREFIX[`/${head}`]
  if (corpus !== undefined && tail !== undefined && (isDocId(tail) || tail === LAST_DOC_ALIAS)) {
    const raw = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    return {
      kind: 'doc',
      corpus,
      prefix: `/${head}`,
      docId: tail,
      fragment: isFragment(raw) ? raw : null,
      query: url.searchParams,
    }
  }
  return { kind: 'notFound', path }
}

function currentUrl(): URL {
  return new URL(globalThis.location.href)
}

const route = signal<Route>({ kind: 'hall' })

export const currentRoute: ReadonlySignal<Route> = route

export function refreshRoute(): void {
  route.value = parseRoute(currentUrl())
}

/** Переход внутри приложения. Фрагмент не трогаем: в нём ключ (§5.1). */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  const next = new URL(to, globalThis.location.origin)
  if (opts?.replace === true) globalThis.history.replaceState(null, '', next.href)
  else globalThis.history.pushState(null, '', next.href)
  refreshRoute()
}

export function startRouter(): void {
  refreshRoute()
  globalThis.addEventListener('popstate', refreshRoute)
}

/** Путь внутри приложения. Абсолютный docUrl() из proto — для показа человеку, не для навигации. */
export function docPath(prefix: string, docId: string, fragment?: string): string {
  return fragment === undefined ? `${prefix}/${docId}` : `${prefix}/${docId}#${fragment}`
}
