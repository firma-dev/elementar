import type { JSX } from 'preact'
import { TrashScreen } from '@elementar/shell'
import type { ActorId, RecordId } from '@elementar/core'
import { S } from '../strings.js'
import type { PlanerStore } from '../store.js'

/** Корзина — приёмочный критерий парного режима (§6.13), поэтому она всегда доступна. */
export function TrashPanel({ store }: { store: PlanerStore }): JSX.Element {
  const doc = store.doc
  const nameOf = (actor: ActorId): string =>
    doc.actors.value.find((a) => a.id === actor)?.name ?? (actor === doc.actor ? 'вы' : 'партнёр')

  return (
    <TrashScreen
      items={doc.trash.items.value}
      nameOf={nameOf}
      ttlDays={30}
      now={Date.now()}
      onRestore={(collection, id) => doc.trash.restore(collection as never, id as RecordId)}
      onPurge={(collection, id) => doc.trash.purge(collection as never, id as RecordId)}
      onPurgeAll={() => doc.trash.purgeAll()}
      data-testid={S.trash.heading}
    />
  )
}

export default TrashPanel
