import fc from 'fast-check'
import { encodeHlc } from '../../src/hlc.js'
import type { HlcString } from '../../src/hlc.js'
import { defineCorpus, f, applyContextOf } from '../../src/schema/define.js'
import { canonicalize } from '../../src/doc/state.js'
import type { DocState } from '../../src/doc/state.js'
import type { ApplyContext } from '../../src/doc/apply.js'
import type { MergeOptions } from '../../src/doc/merge.js'
import type { Op } from '../../src/ops/types.js'

export const LISTS = ['work', 'home', 'hobby', 'craft'] as const

/** Мини-планер: ровно те свойства, от которых зависит слияние. */
export const PLANER = defineCorpus({
  id: 'planer',
  schemaVersion: 1,
  meta: {
    title: f.text({ max: 120 }),
    weekStart: f.enum(['1', '7'] as const, { default: '1' }),
  },
  collections: {
    task: {
      ordered: true,
      groupBy: 'bucket',
      label: (t) => t.title,
      softDeleteDays: 30,
      cold: (t, now) => t.done && t.doneAt !== null && now - t.doneAt > 90 * 864e5,
      fields: {
        title: f.text({ max: 400 }),
        note: f.text({ long: true }),
        bucket: f.tagged({ list: {}, proj: { ref: 'project' } }, { default: 'list:work', onDangling: 'orphan' }),
        done: f.bool(false),
        doneAt: f.nullable(f.number()),
        date: f.nullable(f.date()),
        tags: f.set(),
        seriesId: f.nullable(f.ref('task', { onDangling: 'keep' })),
        occurrenceIndex: f.nullable(f.number()),
      },
    },
    project: {
      ordered: true,
      label: (p) => p.title,
      fields: {
        title: f.text({ max: 200 }),
        note: f.text({ long: true }),
        archived: f.bool(false),
      },
    },
  },
})

export const CTX: ApplyContext = applyContextOf(PLANER)

export const MERGE_OPTS: MergeOptions = {
  keepConflicts: (c, field) => CTX.keepConflicts?.(c, field) ?? false,
}

export const ACTORS = ['aaaa1111', 'bbbb2222', 'cccc3333'] as const
export const BASE_WALL = 1_700_000_000_000

export function hlcAt(index: number, actor: string): HlcString {
  return encodeHlc({ wall: BASE_WALL + index, ctr: 0, actor })
}

export const TASKS = ['task000000000001', 'task000000000002', 'task000000000003'] as const
export const PROJECTS = ['proj000000000001', 'proj000000000002'] as const

export type OpSpec =
  | { t: 'title'; rec: number; actor: number; text: string }
  | { t: 'note'; rec: number; actor: number; text: string }
  | { t: 'done'; rec: number; actor: number; value: boolean }
  | { t: 'bucket'; rec: number; actor: number; bucket: number }
  | { t: 'del'; rec: number; actor: number }
  | { t: 'und'; rec: number; actor: number }
  | { t: 'order'; rec: number; actor: number; key: string }
  | { t: 'tag+'; rec: number; actor: number; tag: string }
  | { t: 'tag-'; rec: number; actor: number; tag: string }
  | { t: 'meta'; actor: number; text: string }
  | { t: 'proj'; rec: number; actor: number; text: string }

const BUCKETS: readonly string[] = [
  'list:work',
  'list:home',
  'list:hobby',
  `proj:${PROJECTS[0]}`,
  `proj:${PROJECTS[1]}`,
]

export const opSpecArb: fc.Arbitrary<OpSpec> = fc.oneof(
  fc.record({ t: fc.constant('title' as const), rec: fc.nat(2), actor: fc.nat(2), text: fc.string({ maxLength: 8 }) }),
  fc.record({ t: fc.constant('note' as const), rec: fc.nat(2), actor: fc.nat(2), text: fc.string({ maxLength: 8 }) }),
  fc.record({ t: fc.constant('done' as const), rec: fc.nat(2), actor: fc.nat(2), value: fc.boolean() }),
  fc.record({ t: fc.constant('bucket' as const), rec: fc.nat(2), actor: fc.nat(2), bucket: fc.nat(4) }),
  fc.record({ t: fc.constant('del' as const), rec: fc.nat(2), actor: fc.nat(2) }),
  fc.record({ t: fc.constant('und' as const), rec: fc.nat(2), actor: fc.nat(2) }),
  fc.record({
    t: fc.constant('order' as const),
    rec: fc.nat(2),
    actor: fc.nat(2),
    key: fc.constantFrom('1', 'V', 'k', '0V', 'zV'),
  }),
  fc.record({ t: fc.constant('tag+' as const), rec: fc.nat(2), actor: fc.nat(2), tag: fc.constantFrom('a', 'b', 'c') }),
  fc.record({ t: fc.constant('tag-' as const), rec: fc.nat(2), actor: fc.nat(2), tag: fc.constantFrom('a', 'b', 'c') }),
  fc.record({ t: fc.constant('meta' as const), actor: fc.nat(2), text: fc.string({ maxLength: 6 }) }),
  fc.record({ t: fc.constant('proj' as const), rec: fc.nat(1), actor: fc.nat(2), text: fc.string({ maxLength: 6 }) }),
)

/** Метки HLC уникальны по построению: их даёт индекс операции в наборе. */
export function buildOps(specs: readonly OpSpec[], offset = 0): Op[] {
  return specs.map((s, n): Op => {
    const i = hlcAt(offset + n, ACTORS[s.actor % ACTORS.length] as string)
    switch (s.t) {
      case 'title':
        return { i, k: 's', c: 'task', r: TASKS[s.rec] as string, v: { title: s.text } }
      case 'note':
        return { i, k: 's', c: 'task', r: TASKS[s.rec] as string, v: { note: s.text } }
      case 'done':
        return { i, k: 's', c: 'task', r: TASKS[s.rec] as string, v: { done: s.value } }
      case 'bucket':
        return { i, k: 's', c: 'task', r: TASKS[s.rec] as string, v: { bucket: BUCKETS[s.bucket] as string } }
      case 'del':
        return { i, k: 'd', c: 'task', r: TASKS[s.rec] as string }
      case 'und':
        return { i, k: 'u', c: 'task', r: TASKS[s.rec] as string }
      case 'order':
        return { i, k: 'o', c: 'task', r: TASKS[s.rec] as string, o: `${s.key}#${ACTORS[s.actor] as string}` }
      case 'tag+':
        return { i, k: 'g+', c: 'task', r: TASKS[s.rec] as string, p: 'tags', e: [s.tag] }
      case 'tag-':
        return { i, k: 'g-', c: 'task', r: TASKS[s.rec] as string, p: 'tags', e: [s.tag] }
      case 'meta':
        return { i, k: 'm', v: { title: s.text } }
      case 'proj':
        return { i, k: 's', c: 'project', r: PROJECTS[s.rec] as string, v: { title: s.text } }
    }
  })
}

export const opsArb = (max = 40): fc.Arbitrary<Op[]> =>
  fc.array(opSpecArb, { maxLength: max }).map((specs) => buildOps(specs))

/** Перестановка по случайным числам: fast-check даёт числа, порядок даём мы. */
export function permute<T>(arr: readonly T[], rnd: readonly number[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rnd[i] ?? 0) % (i + 1)
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

export const permArb = (n = 64): fc.Arbitrary<number[]> => fc.array(fc.nat(1000), { minLength: n, maxLength: n })

export function canon(state: DocState): string {
  return new TextDecoder().decode(canonicalize(state))
}
