import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { toast } from '@elementar/ui'
import { AgentSheet, putDrafts } from '@elementar/shell'
import { collectDrafts, createDocReadonly, describeLlmError } from '@elementar/llm'
import type { RecordId } from '@elementar/core'
import { PLANER } from '../schema.js'
import { S } from '../strings.js'
import { PLANER_TOOLS } from './tools.js'
import { llmSlot } from './registry.js'
import type { PlanerStore } from '../store.js'

export interface AgentPanelProps {
  store: PlanerStore
  open: boolean
  onClose(): void
}

/**
 * Ход агента (§12.10): запрос → прогон → черновики в ProposalStore. Записей агент
 * не создаёт: всё, что он может — предложить, а подтверждает человек.
 */
export function AgentPanel({ store, open, onClose }: AgentPanelProps): JSX.Element {
  const [running, setRunning] = useState(false)
  const [whole, setWhole] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (request: string): Promise<void> => {
    const slot = llmSlot()
    const provider = slot.resolve()
    const config = slot.active.value
    if (provider === null || config === null) {
      setError(S.agent.unavailable)
      return
    }
    setRunning(true)
    setError(null)
    try {
      const doc = createDocReadonly(PLANER, store.doc._state.value, {
        whole,
        ...(whole
          ? {}
          : { container: { collection: 'task', field: 'bucket', value: store.composerBucket.value } }),
      })
      const result = await collectDrafts({
        provider,
        model: config.model,
        tools: PLANER_TOOLS,
        doc,
        request,
        actor: store.doc.actor,
      })
      if (result.error !== null) {
        setError(describeLlmError(result.error.code))
        return
      }
      const ids = await putDrafts(store.doc.session.proposals, result.drafts)
      if (ids.length === 0) {
        setError(S.common.nothingFound)
        return
      }
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <AgentSheet
      open={open}
      onClose={onClose}
      title={S.agent.title}
      examples={[...S.agent.examples]}
      running={running}
      whole={whole}
      onWholeChange={setWhole}
      error={error}
      onSubmit={submit}
    />
  )
}

/** Принятие предложения — одна атомарная транзакция и тост с «Вернуть» (§12.10). */
export function acceptProposal(store: PlanerStore, id: RecordId, only?: number[]): void {
  const proposals = store.doc.session.proposals
  const before = proposals.get(id)
  const count = only === undefined ? (before?.changes.length ?? 0) : only.length
  void proposals.accept(id, only).then(() => {
    toast.show({
      message: S.agent.accepted(count),
      tone: 'success',
      action: {
        label: S.agent.undo,
        onAction: () => {
          store.doc.undo.undo()
        },
      },
    })
  })
}

export default AgentPanel
