/**
 * «Пока вас не было» (§6.12 п.2, §11.9). Показывается один раз после догона,
 * когда изменений набралось больше порога. Ничего не делает с документом —
 * это отчёт, а не действие.
 */
import type { JSX } from 'preact'
import { Button, Divider, EmptyState, ListView, Overlay, Row, cx } from '@elementar/ui'
import type { Base, OverlayCloseReason, Tone } from '@elementar/ui'
import type { ActorId, CatchupDigest, DigestItem, DigestKind } from '@elementar/core'
import { formatLastSeen, withCount } from '../../text.js'

const KIND_TONE: Readonly<Record<DigestKind, Tone>> = {
  created: 'success',
  updated: 'accent',
  deleted: 'danger',
  moved: 'neutral',
}

const KIND_MARK: Readonly<Record<DigestKind, string>> = {
  created: '＋',
  updated: '≡',
  deleted: '−',
  moved: '↕',
}

const KIND_WORD: Readonly<Record<DigestKind, string>> = {
  created: 'добавлено',
  updated: 'изменено',
  deleted: 'удалено',
  moved: 'перенесено',
}

export interface DigestSheetProps extends Base {
  open: boolean
  onClose: (reason: OverlayCloseReason) => void
  digest: CatchupDigest
  /** Имя по актору: из _actors. */
  nameOf?: (actor: ActorId) => string
  /** «Открыть корзину» — удалённое всегда лежит там (§6.12 п.3). */
  onOpenTrash?: () => void
  onOpenItem?: (item: DigestItem) => void
  now?: number
}

/** «добавлено 3, изменено 1, удалено 2» — без родов и склонений по именам. */
export function digestLine(entry: CatchupDigest['byActor'][number]): string {
  const parts: string[] = []
  if (entry.created > 0) parts.push(`${KIND_WORD.created} ${entry.created}`)
  if (entry.updated > 0) parts.push(`${KIND_WORD.updated} ${entry.updated}`)
  if (entry.deleted > 0) parts.push(`${KIND_WORD.deleted} ${entry.deleted}`)
  return parts.length === 0 ? 'без изменений' : parts.join(', ')
}

export function DigestSheet({
  open,
  onClose,
  digest,
  nameOf,
  onOpenTrash,
  onOpenItem,
  now,
  class: cls,
  ...rest
}: DigestSheetProps): JSX.Element {
  const total = digest.items.length
  return (
    <Overlay
      {...rest}
      class={cx('e-digest', cls)}
      open={open}
      onClose={onClose}
      title="Пока вас не было"
      description={digest.since > 0 ? `С ${formatLastSeen(digest.since, now)}` : undefined}
      size="md"
      detents={['content', 'full']}
      primaryAction={{ label: 'Понятно', onAction: () => onClose('action') }}
      {...(onOpenTrash !== undefined
        ? { secondaryAction: { label: 'Открыть корзину', onAction: onOpenTrash } }
        : {})}
    >
      {digest.byActor.length > 0 ? (
        <ul class="e-digest__actors">
          {digest.byActor.map((entry) => (
            <li key={entry.actor} class="e-digest__actor">
              <span class="e-body-strong">{entry.name === '' ? (nameOf?.(entry.actor) ?? 'Партнёр') : entry.name}</span>
              <span class="e-body-sm e-digest__counts">{digestLine(entry)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Divider inset />

      {total === 0 ? (
        <EmptyState size="inline" title="Ничего не изменилось" />
      ) : (
        <ListView
          ariaLabel="Что изменилось"
          items={digest.items}
          getKey={(item) => `${item.collection}:${item.recordId}:${item.kind}`}
          renderItem={(item) => (
            <Row
              tone={item.conflictedWithMine ? 'warning' : KIND_TONE[item.kind]}
              leading={<span class="e-digest__mark" aria-hidden="true">{KIND_MARK[item.kind]}</span>}
              title={item.label}
              subtitle={subtitleOf(item, nameOf)}
              onActivate={onOpenItem === undefined ? undefined : () => onOpenItem(item)}
            />
          )}
        />
      )}

      {total > 0 ? (
        <p class="e-caption e-digest__foot">Всего {withCount(total, ['изменение', 'изменения', 'изменений'])}</p>
      ) : null}

      {onOpenTrash !== undefined ? (
        <Button variant="ghost" fullWidth onClick={onOpenTrash}>
          Открыть корзину
        </Button>
      ) : null}
    </Overlay>
  )
}

function subtitleOf(item: DigestItem, nameOf?: (actor: ActorId) => string): string {
  const who = nameOf?.(item.by) ?? item.by
  const what = KIND_WORD[item.kind]
  const fields = item.fields !== undefined && item.fields.length > 0 ? `: ${item.fields.join(', ')}` : ''
  const conflict = item.conflictedWithMine ? ' · разошлось с вашей правкой' : ''
  return `${who} — ${what}${fields}${conflict}`
}
