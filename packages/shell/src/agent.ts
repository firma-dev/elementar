/**
 * Стык агента и документа. Единственное место в оболочке, где черновики попадают
 * в документ, — и попадают они в `_proposals`, то есть остаются предложениями
 * до подтверждения человеком (§10.4).
 */
import type { ProposalDraft, ProposalOrigin, ProposalStore, RecordId } from '@elementar/core'
import type { AgentRunResult } from '@elementar/llm'

export interface DraftWithOrigin {
  draft: ProposalDraft
  origin: ProposalOrigin
}

/** Черновики прогона → записи `_proposals`. Данные документа при этом не меняются. */
export async function putDrafts(
  store: ProposalStore,
  drafts: readonly DraftWithOrigin[],
): Promise<RecordId[]> {
  const ids: RecordId[] = []
  for (const d of drafts) {
    if (d.draft.changes.length === 0) continue
    ids.push(await store.put(d.draft, d.origin))
  }
  return ids
}

/** Сколько изменений принесёт прогон — для тоста «7 задач добавлено». */
export function draftedChanges(result: AgentRunResult): number {
  return result.drafts.reduce((sum, d) => sum + d.draft.changes.length, 0)
}
