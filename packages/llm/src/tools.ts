/**
 * Правило слоёв, зашитое в типы (§10.4).
 *
 * ToolContext не содержит tx, create, update — у агента физически нет мутирующего API.
 * ProposeTool.plan умеет вернуть только ProposalDraft: черновик, который человек
 * подтверждает жестом в интерфейсе. Ни один инструмент не может записать в документ.
 */
import type { CollectionsDef, ProposalChange, ProposalDraft, RecordId } from '@elementar/core'
import type { DocReadonly } from './slice.js'
import type { JsonSchema, LlmToolSpec } from './types.js'

export interface ToolContext<S extends CollectionsDef> {
  /** Только чтение. У агента физически нет мутирующего API. */
  readonly doc: DocReadonly<S>
  now(): Date
  readonly signal: AbortSignal
}

export interface ToolBase {
  readonly name: string
  readonly description: string
  readonly input: JsonSchema
}

export interface ReadTool<S extends CollectionsDef, I = unknown, O = unknown> extends ToolBase {
  readonly effect: 'read'
  /** Проверка сырого ввода модели. null → инструмент не запускается. */
  parse?(raw: unknown): I | null
  run(input: I, ctx: ToolContext<S>): Promise<O>
}

export interface ProposeTool<S extends CollectionsDef, I = unknown> extends ToolBase {
  readonly effect: 'propose'
  parse?(raw: unknown): I | null
  plan(input: I, ctx: ToolContext<S>): Promise<ProposalDraft>
}

/**
 * Стёртый тип инструмента. Вход `never` — приём, который делает список инструментов
 * с разными формами ввода однородным, не вводя `any`.
 */
export type AgentTool<S extends CollectionsDef> = ReadTool<S, never, unknown> | ProposeTool<S, never>

export function isReadTool<S extends CollectionsDef>(t: AgentTool<S>): t is ReadTool<S, never, unknown> {
  return t.effect === 'read'
}

export function isProposeTool<S extends CollectionsDef>(t: AgentTool<S>): t is ProposeTool<S, never> {
  return t.effect === 'propose'
}

/** Объявление инструментов для модели: наружу уходят только имя, описание и схема. */
export function toolSpecs<S extends CollectionsDef>(tools: readonly AgentTool<S>[]): LlmToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input: t.input }))
}

export function findTool<S extends CollectionsDef>(
  tools: readonly AgentTool<S>[],
  name: string,
): AgentTool<S> | undefined {
  return tools.find((t) => t.name === name)
}

/**
 * Приведение авторского инструмента к стёртому виду. Единственное место,
 * где происходит сужение — здесь же проверяется ввод.
 */
export function readTool<S extends CollectionsDef, I, O>(
  spec: Omit<ReadTool<S, I, O>, 'effect'> & { effect?: 'read' },
): AgentTool<S> {
  return { ...spec, effect: 'read' } as unknown as ReadTool<S, never, unknown>
}

export function proposeTool<S extends CollectionsDef, I>(
  spec: Omit<ProposeTool<S, I>, 'effect'> & { effect?: 'propose' },
): AgentTool<S> {
  return { ...spec, effect: 'propose' } as unknown as ProposeTool<S, never>
}

/** Проверка ввода инструмента: без parse ответственность на самом инструменте. */
export function parseToolInput<S extends CollectionsDef>(tool: AgentTool<S>, raw: unknown): never | null {
  if (tool.parse === undefined) return raw as never
  return tool.parse(raw)
}

/** Хелпер из §12.10: draft({ title, changes }). */
export function draft(d: ProposalDraft): ProposalDraft {
  return d
}

export interface CreateChangeArgs {
  collection: string
  recordId: RecordId
  label: string
  after: Record<string, unknown>
  ops: ProposalChange['ops']
}

/** Собрать изменение-создание: ops лежат ВНУТРИ изменения, чтобы accept(id, only) был однозначен. */
export function createChange(a: CreateChangeArgs): ProposalChange {
  return {
    kind: 'create',
    collection: a.collection,
    recordId: a.recordId,
    label: a.label,
    after: a.after,
    ops: a.ops,
  }
}

/** Сумма изменений предложения — для строки «Оставить N задач». */
export function changeCount(d: ProposalDraft): number {
  return d.changes.length
}
