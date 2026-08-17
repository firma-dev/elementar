/**
 * Предложения агента как НАЛОЖЕНИЕ поверх списка (§10.4, §12.10).
 * Строки рисуются из ProposalChange, а не из записей: предложения не попадают
 * ни в счётчики, ни в поиск, ни в экспорт — по построению, они не записи.
 * Принять можно всё или выбранное; ops лежат внутри каждого изменения,
 * поэтому accept(id, only) однозначен.
 */
import type { JSX } from 'preact'
import { useCallback, useMemo, useState } from 'preact/hooks'
import { Button, Row, Spinner, cx } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import type { Proposal, RecordId } from '@elementar/core'
import { TASKS } from '../../text.js'
import { acceptArgs, acceptLabel, changedFields, keptIndices, kindTitle, proposalAuthorLine } from './proposal.js'

export interface AgentProposalProps extends Base {
  proposal: Proposal
  /** Имя того, кто запустил агента: из _actors. */
  authorName?: string
  /** Своё предложение — подпись не нужна. */
  mine?: boolean
  /** Базовые ячейки изменились с момента предложения. */
  stale?: boolean
  onAccept: (id: RecordId, only?: number[]) => void | Promise<void>
  onReject: (id: RecordId) => void | Promise<void>
  /** Тап по строке открывает правку ПРЕДЛОЖЕНИЯ, а не задачи. */
  onEdit?: (id: RecordId, changeIndex: number) => void
  onRebase?: (id: RecordId) => void | Promise<void>
  /** Склонение для кнопки: по умолчанию «задача/задачи/задач». */
  noun?: readonly [string, string, string]
}

export function AgentProposal({
  proposal,
  authorName,
  mine = false,
  stale = false,
  onAccept,
  onReject,
  onEdit,
  onRebase,
  noun = TASKS,
  class: cls,
  ...rest
}: AgentProposalProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [busy, setBusy] = useState(false)
  const total = proposal.changes.length
  const kept = useMemo(() => keptIndices(total, dismissed), [total, dismissed])

  const accept = useCallback(async () => {
    setBusy(true)
    try {
      await onAccept(proposal.id, acceptArgs(total, kept))
    } finally {
      setBusy(false)
    }
  }, [kept, onAccept, proposal.id, total])

  const reject = useCallback(async () => {
    setBusy(true)
    try {
      await onReject(proposal.id)
    } finally {
      setBusy(false)
    }
  }, [onReject, proposal.id])

  const dismissOne = useCallback((index: number) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(index)
      return next
    })
  }, [])

  if (kept.length === 0) return null

  return (
    <section
      {...rest}
      class={cx('e-proposal', cls)}
      data-tone="agent"
      aria-label={`Предложено: ${kept.length}`}
    >
      <header class="e-proposal__head">
        <span class="e-overline e-proposal__title">
          <span aria-hidden="true">✧</span> Предложено · {kept.length}
        </span>
        <div class="e-proposal__head-actions">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reject()}>
            Убрать все
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void accept()}>
            Оставить все
          </Button>
        </div>
      </header>

      {!mine ? <p class="e-caption e-proposal__author">{proposalAuthorLine(authorName)}</p> : null}
      {proposal.rationale !== undefined && proposal.rationale !== '' ? (
        <p class="e-body-sm e-proposal__rationale">{proposal.rationale}</p>
      ) : null}

      {stale ? (
        <div class="e-proposal__stale">
          <span class="e-body-sm">Записи изменились с момента предложения</span>
          {onRebase !== undefined ? (
            <Button size="sm" onClick={() => void onRebase(proposal.id)}>
              Обновить
            </Button>
          ) : null}
        </div>
      ) : null}

      <ul class="e-proposal__list e-stagger">
        {kept.map((index) => {
          const change = proposal.changes[index]
          if (change === undefined) return null
          const fields = changedFields(change)
          return (
            <li key={`${change.recordId}-${index}`}>
              <Row
                proposed
                tone="agent"
                leading={<span class="e-proposal__mark" aria-hidden="true">✧</span>}
                title={change.label}
                subtitle={
                  change.kind === 'create'
                    ? undefined
                    : `${kindTitle(change.kind)}${fields.length > 0 ? `: ${fields.join(', ')}` : ''}`
                }
                trailing={
                  <button
                    type="button"
                    class="e-proposal__dismiss"
                    aria-label={`Убрать предложение «${change.label}»`}
                    onClick={() => dismissOne(index)}
                  >
                    ✕
                  </button>
                }
                onActivate={onEdit === undefined ? undefined : () => onEdit(proposal.id, index)}
              />
            </li>
          )
        })}
      </ul>

      <footer class="e-proposal__foot">
        <Button variant="primary" fullWidth disabled={busy} onClick={() => void accept()}>
          {busy ? <Spinner size={16} /> : acceptLabel(kept.length, noun)}
        </Button>
      </footer>
    </section>
  )
}

export interface AgentProposalsProps extends Base {
  proposals: readonly Proposal[]
  authorNameOf?: (proposal: Proposal) => string | undefined
  isMine?: (proposal: Proposal) => boolean
  isStale?: (proposal: Proposal) => boolean
  onAccept: (id: RecordId, only?: number[]) => void | Promise<void>
  onReject: (id: RecordId) => void | Promise<void>
  onEdit?: (id: RecordId, changeIndex: number) => void
  onRebase?: (id: RecordId) => void | Promise<void>
  noun?: readonly [string, string, string]
}

/** Наложение целиком: несколько предложений идут стопкой поверх списка. */
export function AgentProposals({
  proposals,
  authorNameOf,
  isMine,
  isStale,
  onAccept,
  onReject,
  onEdit,
  onRebase,
  noun,
  class: cls,
  ...rest
}: AgentProposalsProps): JSX.Element | null {
  if (proposals.length === 0) return null
  return (
    <div {...rest} class={cx('e-proposals', cls)}>
      {proposals.map((p) => (
        <AgentProposal
          key={p.id}
          proposal={p}
          authorName={authorNameOf?.(p)}
          mine={isMine?.(p) ?? false}
          stale={isStale?.(p) ?? false}
          onAccept={onAccept}
          onReject={onReject}
          onEdit={onEdit}
          onRebase={onRebase}
          noun={noun}
        />
      ))}
    </div>
  )
}
