import type { JSX } from 'preact'
import { EmptyState } from '@elementar/ui'
import { H } from '../../shell/strings.js'
import { navigate } from '../../routes.js'

/**
 * Финансер — заглушка, НЕ В v1 (§1.5, §2.1). Дверь существует только как маршрут:
 * когда она появится, она встанет на ту же оболочку и в то же хранилище (§13.1),
 * поэтому отдельного манифеста и отдельного scope у неё не будет.
 */
export function FinanserDoor(): JSX.Element {
  return (
    <main class="h-hall e-content">
      <EmptyState
        size="page"
        title={H.finanser.title}
        description={H.finanser.hint}
        action={{ label: H.finanser.back, onAction: () => navigate('/') }}
      />
    </main>
  )
}

export default FinanserDoor
