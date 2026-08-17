import type { ProposalChange } from '@elementar/core'
import { plural } from '../../text.js'

/** Индексы изменений, которые человек не убрал крестиком. */
export function keptIndices(total: number, dismissed: ReadonlySet<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < total; i++) if (!dismissed.has(i)) out.push(i)
  return out
}

/**
 * `accept(id, only)` вызывается без `only`, когда оставляют всё:
 * частичное принятие — это именно выбор подмножества.
 */
export function acceptArgs(total: number, kept: readonly number[]): number[] | undefined {
  return kept.length === total ? undefined : [...kept]
}

export function acceptLabel(n: number, forms: readonly [string, string, string]): string {
  return `Оставить ${n} ${plural(n, forms)}`
}

const KIND_TITLE: Readonly<Record<ProposalChange['kind'], string>> = {
  create: 'Новая запись',
  update: 'Правка',
  delete: 'Удаление',
  move: 'Перенос',
}

export function kindTitle(kind: ProposalChange['kind']): string {
  return KIND_TITLE[kind]
}

/** Поля, которых касается изменение — для подписи под строкой. */
export function changedFields(change: ProposalChange): string[] {
  const after = change.after
  if (after === undefined) return []
  return Object.keys(after)
}

/** Партнёру предложения видны с пометкой «Виктор попросил агента» (§12.10). */
export function proposalAuthorLine(authorName?: string): string {
  return `${authorName ?? 'Партнёр'} попросил агента`
}
