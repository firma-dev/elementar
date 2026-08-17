import type { JSX } from 'preact'
import { EmptyState } from '@elementar/ui'
import { H } from './strings.js'
import { navigate } from '../routes.js'

export function NotFound({ path }: { path?: string }): JSX.Element {
  return (
    <main class="h-hall e-content">
      <EmptyState
        size="page"
        title={H.notFound.title}
        description={path === undefined ? H.notFound.hint : `${H.notFound.hint} (${path})`}
        action={{ label: H.notFound.home, onAction: () => navigate('/') }}
      />
    </main>
  )
}
