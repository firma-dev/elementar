import { describe, expect, it } from 'vitest'
import {
  CHAIN_DISAGREE_MS,
  ChainWatch,
  EMPTY_HEAD,
  advanceChain,
  decodeBatchPlaintext,
  emptyChain,
  encodeBatchPlaintext,
  headOfBatch,
  isChainHead,
  verifyChain,
} from '../../src/sync/chain.js'
import type { DecryptedBatch } from '../../src/sync/chain.js'
import type { Op } from '../../src/ops/types.js'

let counter = 0
function op(title: string, actor = 'aaaaaaaa'): Op {
  counter += 1
  const wall = (0x100000000 + counter).toString(16).padStart(12, '0')
  return {
    i: `${wall}-0000-${actor}`,
    k: 's',
    c: 'tasks',
    r: 'r0000000000000001',
    v: { title },
  }
}

function batch(seq: number, prevHead: string, ops: Op[]): DecryptedBatch {
  return { seq, prevHead, ops }
}

describe('хеш-цепочка лога', () => {
  it('голова зависит и от предыдущей головы, и от содержимого', () => {
    const a = [op('раз')]
    const h1 = headOfBatch(EMPTY_HEAD, a)
    const h2 = headOfBatch(h1, a)
    expect(h1).not.toBe(h2)
    expect(isChainHead(h1)).toBe(true)
    expect(headOfBatch(EMPTY_HEAD, a)).toBe(h1)
    expect(headOfBatch(EMPTY_HEAD, [op('два')])).not.toBe(h1)
  })

  it('открытый текст пакета — prevHead(32) ‖ json(Op[])', () => {
    const ops = [op('переезд'), op('коробки')]
    const head = headOfBatch(EMPTY_HEAD, ops)
    const bytes = encodeBatchPlaintext(EMPTY_HEAD, ops)
    expect(bytes.length).toBeGreaterThan(32)
    const decoded = decodeBatchPlaintext(bytes)
    expect(decoded).not.toBeNull()
    expect(decoded?.prevHead).toBe(EMPTY_HEAD)
    expect(decoded?.ops.length).toBe(2)
    expect(decoded?.head).toBe(head)
  })

  it('непустая голова переживает кодирование', () => {
    const h = headOfBatch(EMPTY_HEAD, [op('первый')])
    const decoded = decodeBatchPlaintext(encodeBatchPlaintext(h, [op('второй')]))
    expect(decoded?.prevHead).toBe(h)
  })

  it('мусор вместо пакета не разбирается', () => {
    expect(decodeBatchPlaintext(new Uint8Array(10))).toBeNull()
    expect(decodeBatchPlaintext(new Uint8Array(40))).toBeNull()
  })
})

describe('проверка цепочки', () => {
  it('последовательная выдача принимается', () => {
    const o1 = [op('a')]
    const o2 = [op('b')]
    const h1 = headOfBatch(EMPTY_HEAD, o1)
    const v = verifyChain(emptyChain(), [batch(1, EMPTY_HEAD, o1), batch(2, h1, o2)])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.head).toBe(headOfBatch(h1, o2))
  })

  it('придержанная дельта видна как gap', () => {
    const o1 = [op('a')]
    const o2 = [op('b')]
    const o3 = [op('c')]
    const h1 = headOfBatch(EMPTY_HEAD, o1)
    const h2 = headOfBatch(h1, o2)
    // сервер отдал 1 и 3, спрятав 2
    const v = verifyChain(emptyChain(), [batch(1, EMPTY_HEAD, o1), batch(3, h2, o3)])
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.kind).toBe('gap')
      expect(v.atSeq).toBe(3)
      expect(v.got).toBe(h2)
    }
  })

  it('переписанная история того же seq — форк', () => {
    const first = [op('жена перенесла')]
    const second = [op('муж перенёс')]
    const chain0 = advanceChain(emptyChain(), [batch(1, EMPTY_HEAD, first)])
    const v = verifyChain(chain0, [batch(1, EMPTY_HEAD, second)])
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.kind).toBe('fork')
      expect(v.atSeq).toBe(1)
      expect(v.expected).toBe(headOfBatch(EMPTY_HEAD, first))
    }
  })

  it('параллельные ветки от одной головы — норма, а не форк', () => {
    const base = advanceChain(emptyChain(), [batch(1, EMPTY_HEAD, [op('база')])])
    const her = [op('её правка', 'bbbbbbbb')]
    const his = [op('его правка', 'cccccccc')]
    // оба писали офлайн от общей головы: сервер присвоил разные seq
    const v = verifyChain(base, [batch(2, base.head, her), batch(3, base.head, his)])
    expect(v.ok).toBe(true)
  })

  it('цепочка сходится: следующий пакет ссылается на достижимую голову', () => {
    const base = advanceChain(emptyChain(), [batch(1, EMPTY_HEAD, [op('база')])])
    const her = [op('её', 'bbbbbbbb')]
    const branch = advanceChain(base, [batch(2, base.head, her)])
    const v = verifyChain(branch, [batch(3, base.head, [op('его', 'cccccccc')])])
    expect(v.ok).toBe(true)
  })

  it('верификация ничего не меняет в переданном состоянии', () => {
    const chain = emptyChain()
    verifyChain(chain, [batch(1, EMPTY_HEAD, [op('x')])])
    expect(chain.head).toBe(EMPTY_HEAD)
    expect(chain.bySeq.size).toBe(0)
  })

  it('advanceChain двигает голову и помнит соответствие seq → head', () => {
    const o1 = [op('a')]
    const next = advanceChain(emptyChain(), [batch(4, EMPTY_HEAD, o1)])
    expect(next.head).toBe(headOfBatch(EMPTY_HEAD, o1))
    expect(next.bySeq.get(4)).toBe(next.head)
  })
})

describe('сверка голов с партнёром', () => {
  it('расхождение дольше минуты при пустых outbox поднимает баннер', () => {
    const w = new ChainWatch()
    expect(w.note({ mine: 'A', theirs: 'B', outboxEmpty: true, now: 0 })).toBe(false)
    expect(w.note({ mine: 'A', theirs: 'B', outboxEmpty: true, now: CHAIN_DISAGREE_MS - 1 })).toBe(
      false,
    )
    expect(w.note({ mine: 'A', theirs: 'B', outboxEmpty: true, now: CHAIN_DISAGREE_MS })).toBe(true)
    expect(w.warning).toBe(true)
  })

  it('непустая очередь — законная причина расхождения', () => {
    const w = new ChainWatch()
    w.note({ mine: 'A', theirs: 'B', outboxEmpty: true, now: 0 })
    expect(w.note({ mine: 'A', theirs: 'B', outboxEmpty: false, now: CHAIN_DISAGREE_MS })).toBe(
      false,
    )
    expect(w.disagreeSince).toBeNull()
  })

  it('совпавшие головы гасят предупреждение', () => {
    const w = new ChainWatch()
    w.note({ mine: 'A', theirs: 'B', outboxEmpty: true, now: 0 })
    w.note({ mine: 'A', theirs: 'B', outboxEmpty: true, now: CHAIN_DISAGREE_MS })
    expect(w.warning).toBe(true)
    w.note({ mine: 'A', theirs: 'A', outboxEmpty: true, now: CHAIN_DISAGREE_MS + 1 })
    expect(w.warning).toBe(false)
  })
})
