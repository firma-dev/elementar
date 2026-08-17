/**
 * «Недавно удалённые» (§11.9, §6.12 п.3). Удалённое партнёром всегда попадает сюда —
 * это и есть страховка от чужого удаления, а не запрет удалять.
 */
import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { Button, EmptyState, ListView, Overlay, Row, cx } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import { hlcWall } from '@elementar/core'
import type { ActorId, RecordId, TrashItem } from '@elementar/core'
import { formatLastSeen } from '../../text.js'

export interface TrashScreenProps extends Base {
  items: readonly TrashItem[]
  /** Имя по актору: из _actors. */
  nameOf?: (actor: ActorId) => string
  onRestore: (collection: string, id: RecordId) => void
  onPurge: (collection: string, id: RecordId) => void
  onPurgeAll?: () => void
  /** Через сколько дней содержимое исчезнет само. */
  ttlDays?: number
  now?: number
}

export function TrashScreen({
  items,
  nameOf,
  onRestore,
  onPurge,
  onPurgeAll,
  ttlDays = 30,
  now,
  class: cls,
  ...rest
}: TrashScreenProps): JSX.Element {
  const [confirmAll, setConfirmAll] = useState(false)

  return (
    <div {...rest} class={cx('e-trash', cls)}>
      {items.length === 0 ? (
        <EmptyState
          size="page"
          title="Корзина пуста"
          description={`Удалённое лежит здесь ${ttlDays} дней, потом исчезает само.`}
        />
      ) : (
        <>
          <p class="e-caption e-trash__hint">Удалённое лежит здесь {ttlDays} дней, потом исчезает само.</p>
          <ListView
            ariaLabel="Недавно удалённые"
            items={items}
            getKey={(item) => `${item.collection}:${item.id}`}
            renderItem={(item) => (
              <Row
                muted
                tone={item.byPeer ? 'accent' : 'neutral'}
                title={item.label}
                subtitle={subtitleOf(item, nameOf, now)}
                swipe={{
                  right: {
                    label: 'Вернуть',
                    icon: '↩',
                    tone: 'success',
                    onAction: () => onRestore(item.collection, item.id),
                  },
                  left: [
                    {
                      label: 'Удалить навсегда',
                      icon: '✕',
                      tone: 'danger',
                      confirm: true,
                      onAction: () => onPurge(item.collection, item.id),
                    },
                  ],
                }}
              />
            )}
          />
          {onPurgeAll !== undefined ? (
            <Button variant="danger" fullWidth onClick={() => setConfirmAll(true)}>
              Очистить корзину
            </Button>
          ) : null}
        </>
      )}

      <Overlay
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        presentation="dialog"
        size="sm"
        title="Очистить корзину?"
        primaryAction={{
          label: 'Очистить',
          tone: 'danger',
          onAction: () => {
            onPurgeAll?.()
            setConfirmAll(false)
          },
        }}
        secondaryAction={{ label: 'Отмена', onAction: () => setConfirmAll(false) }}
      >
        <p class="e-body">Записи исчезнут насовсем — и у вас, и у партнёра.</p>
      </Overlay>
    </div>
  )
}

function subtitleOf(item: TrashItem, nameOf?: (actor: ActorId) => string, now?: number): string {
  const who = item.byPeer ? (nameOf?.(item.deletedBy) ?? 'партнёр') : 'вы'
  const when = formatLastSeen(hlcWall(item.deletedAt), now)
  const edited = item.editedAfterDelete ? ' · правили после удаления' : ''
  return `Удалено: ${who}, ${when}${edited}`
}
