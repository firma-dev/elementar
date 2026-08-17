/**
 * Хеш-цепочка лога: детекция форка и придерживания (§6.11).
 *
 *   plaintext(OpBatch) = prevHead(32) ‖ json(Op[])
 *   newHead = SHA-256( prevHead ‖ sha256(json(Op[])) )
 *
 * Голова хранится строкой base32 (32 байта), как `DocState.chainHead`; пустая голова — ''.
 * Проверка формулируется как «голова достижима», а не «голова равна»: параллельные ветки
 * двух офлайн-устройств — норма, цепочка сходится позже.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { SIZES } from '@elementar/proto'
import { b32encode, tryB32decodeExact } from '../crypto/b32.js'
import { concatBytes, fromUtf8 } from '../util/bytes.js'
import { decodeOps, opsJsonBytes } from '../ops/codec.js'
import type { AnyOp } from '../ops/types.js'

export const CHAIN_HASH_BYTES = SIZES.CHAIN_HASH_BYTES
/** Пустая голова: 32 нулевых байта в открытом тексте, '' в состоянии. */
export const EMPTY_HEAD = ''
/** Сколько последних seq держим в памяти для сверки повторной выдачи. */
export const CHAIN_MEMORY = 512
/** Головы двух онлайн-пиров не сходятся дольше минуты при пустых outbox — баннер (§6.11). */
export const CHAIN_DISAGREE_MS = 60_000

export interface ChainState {
  head: string
  bySeq: Map<number, string>
}

export type ChainVerdict =
  | { ok: true; head: string }
  | { ok: false; kind: 'gap' | 'fork'; atSeq: number; expected: string; got: string }

/** Расшифрованный OpBatch: серверный seq снаружи, prevHead и операции — изнутри пакета. */
export interface DecryptedBatch {
  seq: number
  prevHead: string
  ops: AnyOp[]
}

export function emptyChain(head: string = EMPTY_HEAD): ChainState {
  return { head, bySeq: new Map() }
}

export function cloneChain(c: ChainState): ChainState {
  return { head: c.head, bySeq: new Map(c.bySeq) }
}

function headBytes(head: string): Uint8Array {
  if (head === EMPTY_HEAD) return new Uint8Array(CHAIN_HASH_BYTES)
  const raw = tryB32decodeExact(head, CHAIN_HASH_BYTES)
  return raw ?? new Uint8Array(CHAIN_HASH_BYTES)
}

export function isChainHead(head: string): boolean {
  return head === EMPTY_HEAD || tryB32decodeExact(head, CHAIN_HASH_BYTES) !== null
}

/** newHead = SHA-256(prevHead ‖ sha256(json)). */
export function nextHead(prevHead: string, opsJson: Uint8Array): string {
  return b32encode(sha256(concatBytes(headBytes(prevHead), sha256(opsJson))))
}

export function headOfBatch(prevHead: string, ops: readonly AnyOp[]): string {
  return nextHead(prevHead, opsJsonBytes(ops))
}

/** Открытый текст OpBatch: голова цепочки на момент создания + JSON операций. */
export function encodeBatchPlaintext(prevHead: string, ops: readonly AnyOp[]): Uint8Array {
  return concatBytes(headBytes(prevHead), opsJsonBytes(ops))
}

export interface DecodedBatch {
  prevHead: string
  ops: AnyOp[]
  /** Голова после этого батча. */
  head: string
}

export function decodeBatchPlaintext(bytes: Uint8Array): DecodedBatch | null {
  if (bytes.length < CHAIN_HASH_BYTES) return null
  const prevRaw = bytes.subarray(0, CHAIN_HASH_BYTES)
  const json = bytes.subarray(CHAIN_HASH_BYTES)
  let allZero = true
  for (let i = 0; i < prevRaw.length; i++)
    if (prevRaw[i] !== 0) {
      allZero = false
      break
    }
  const prevHead = allZero ? EMPTY_HEAD : b32encode(prevRaw)
  const ops = decodeOps(fromUtf8(json))
  // пустой JSON-мусор отличаем от пустой пачки: '[]' валиден, всё прочее — нет
  const text = fromUtf8(json).trim()
  if (text.length === 0) return null
  if (ops.length === 0 && text !== '[]') return null
  return { prevHead, ops, head: nextHead(prevHead, json) }
}

/**
 * Проверка пачки против известных голов. Ничего не мутирует.
 * `gap` — prevHead недостижим: сервер придержал часть истории.
 * `fork` — для того же seq уже была другая голова: историю переписали.
 */
export function verifyChain(prev: ChainState, batch: readonly DecryptedBatch[]): ChainVerdict {
  const known = new Set<string>(prev.bySeq.values())
  known.add(prev.head)
  known.add(EMPTY_HEAD)
  let head = prev.head
  const sorted = [...batch].sort((a, b) => a.seq - b.seq)
  for (const b of sorted) {
    if (!known.has(b.prevHead)) {
      return { ok: false, kind: 'gap', atSeq: b.seq, expected: head, got: b.prevHead }
    }
    const nh = headOfBatch(b.prevHead, b.ops)
    const seen = prev.bySeq.get(b.seq)
    if (seen !== undefined && seen !== nh) {
      return { ok: false, kind: 'fork', atSeq: b.seq, expected: seen, got: nh }
    }
    known.add(nh)
    head = nh
  }
  return { ok: true, head }
}

/** Принять проверенную пачку: новое состояние цепочки, старое не меняется. */
export function advanceChain(prev: ChainState, batch: readonly DecryptedBatch[]): ChainState {
  const next = cloneChain(prev)
  const sorted = [...batch].sort((a, b) => a.seq - b.seq)
  for (const b of sorted) {
    const nh = headOfBatch(b.prevHead, b.ops)
    next.bySeq.set(b.seq, nh)
    next.head = nh
  }
  if (next.bySeq.size > CHAIN_MEMORY) {
    const seqs = [...next.bySeq.keys()].sort((a, b) => a - b)
    for (const s of seqs.slice(0, next.bySeq.size - CHAIN_MEMORY)) next.bySeq.delete(s)
  }
  return next
}

/**
 * Сверка голов с онлайн-пиром (§6.11). Расхождение дольше CHAIN_DISAGREE_MS
 * при пустых outbox — повод показать громкий баннер.
 */
export class ChainWatch {
  #disagreeSince: number | null = null
  #warning = false

  get warning(): boolean {
    return this.#warning
  }

  get disagreeSince(): number | null {
    return this.#disagreeSince
  }

  /** Вернёт true, когда расхождение стало устойчивым. */
  note(args: { mine: string; theirs: string; outboxEmpty: boolean; now: number }): boolean {
    const agree = args.mine === args.theirs
    if (agree || !args.outboxEmpty) {
      this.#disagreeSince = null
      this.#warning = false
      return false
    }
    if (this.#disagreeSince === null) this.#disagreeSince = args.now
    this.#warning = args.now - this.#disagreeSince >= CHAIN_DISAGREE_MS
    return this.#warning
  }

  reset(): void {
    this.#disagreeSince = null
    this.#warning = false
  }
}
