/**
 * Роутер без фреймворка. Разбирает только форму пути; валидность docId проверяется дальше,
 * потому что неверный формат обязан давать тот же самый 404, что и «нет такого документа».
 */
import { API_PREFIX } from '@elementar/proto'

export type RouteName =
  | 'health'
  | 'challenge'
  | 'docs.create'
  | 'docs.meta'
  | 'docs.delete'
  | 'docs.undelete'
  | 'docs.wrap'
  | 'docs.snapshot.get'
  | 'docs.snapshot.put'
  | 'docs.deltas.get'
  | 'docs.deltas.post'
  | 'docs.ws'
  | 'invite.create'
  | 'invite.get'
  | 'llm'

export interface Route {
  name: RouteName
  docId?: string
  iid?: string
  provider?: string
}

/** Операции, меняющие содержимое документа: их гасит флаг accept_writes. */
export const WRITE_ROUTES: readonly RouteName[] = [
  'docs.deltas.post',
  'docs.snapshot.put',
  'docs.wrap',
]

export function matchRoute(method: string, pathname: string): Route | null {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return null
  const seg = pathname.slice(API_PREFIX.length + 1).split('/')
  const [a, b, c, extra] = seg
  if (extra !== undefined) return null

  if (a === 'health' && b === undefined) return method === 'GET' ? { name: 'health' } : null
  if (a === 'challenge' && b === undefined) return method === 'GET' ? { name: 'challenge' } : null

  if (a === 'docs') {
    if (b === undefined) return method === 'POST' ? { name: 'docs.create' } : null
    if (b === '') return null
    if (c === undefined) {
      if (method === 'GET') return { name: 'docs.meta', docId: b }
      if (method === 'DELETE') return { name: 'docs.delete', docId: b }
      return null
    }
    switch (c) {
      case 'snapshot':
        if (method === 'GET') return { name: 'docs.snapshot.get', docId: b }
        if (method === 'PUT') return { name: 'docs.snapshot.put', docId: b }
        return null
      case 'deltas':
        if (method === 'GET') return { name: 'docs.deltas.get', docId: b }
        if (method === 'POST') return { name: 'docs.deltas.post', docId: b }
        return null
      case 'wrap':
        return method === 'PUT' ? { name: 'docs.wrap', docId: b } : null
      case 'undelete':
        return method === 'POST' ? { name: 'docs.undelete', docId: b } : null
      case 'ws':
        return method === 'GET' ? { name: 'docs.ws', docId: b } : null
      default:
        return null
    }
  }

  if (a === 'invite') {
    if (b === undefined) return method === 'POST' ? { name: 'invite.create' } : null
    if (c !== undefined || b === '') return null
    return method === 'GET' ? { name: 'invite.get', iid: b } : null
  }

  if (a === 'llm' && b !== undefined && b !== '' && c === undefined) {
    return method === 'POST' ? { name: 'llm', provider: b } : null
  }

  return null
}
