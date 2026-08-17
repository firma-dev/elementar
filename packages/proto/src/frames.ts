/**
 * Кодек транспортного кадра (§8.4). Один и тот же код на клиенте и на сервере.
 *
 * пакет:
 *   0  1  magic = 0xE1
 *   1  1  ver   = 0x01
 *   2  2  count (u16 LE)
 *   4  …  count × frame
 *
 * frame:
 *   +0   8  seq       (u64 LE)  0 в направлении клиент→сервер
 *   +8   8  clientId
 *   +16  4  clientSeq (u32 LE)
 *   +20  8  ts        (u64 LE, ms)  0 в направлении клиент→сервер
 *   +28  4  len       (u32 LE)
 *   +32 len payload   ← EL1-пакет (§4.4), сервер его не разбирает
 *
 * Любое нарушение при разборе → ELM_BAD_FRAME, ни одного исключения наружу.
 */
import { C } from './consts.js'
import { isPacketType } from './keys.js'
import type { PacketType } from './keys.js'

export const PACKET_MAGIC = 0xe1
export const PACKET_VERSION = 0x01
export const PACKET_HEADER_BYTES = 4
export const FRAME_HEADER_BYTES = 32
export const CLIENT_ID_BYTES = 8

/** 'E','L','1' — первые три байта payload (§4.4). */
const EL1 = [0x45, 0x4c, 0x31] as const

const U32_MAX = 0xffff_ffff
const SAFE_MAX = Number.MAX_SAFE_INTEGER

export interface Frame {
  /** Серверный номер; 0 в направлении клиент→сервер. */
  seq: number
  /** 8 байт, случайные, на пару (устройство, документ). */
  clientId: Uint8Array
  clientSeq: number
  /** Серверное время в мс; 0 в направлении клиент→сервер. */
  ts: number
  /** EL1-пакет целиком. */
  payload: Uint8Array
}

export type FrameDirection = 'c2s' | 's2c'

export interface FrameCodecOptions {
  /** 'c2s' дополнительно требует seq === 0 и ts === 0. */
  direction?: FrameDirection
}

export type FrameRejectReason =
  | 'short-header'
  | 'bad-magic'
  | 'bad-version'
  | 'too-many-frames'
  | 'truncated'
  | 'delta-too-large'
  | 'packet-too-large'
  | 'not-el1'
  | 'trailing-bytes'
  | 'seq-unsafe'
  | 'ts-unsafe'
  | 'seq-not-zero'
  | 'ts-not-zero'
  | 'bad-client-id'
  | 'bad-client-seq'
  | 'bad-doc-id'
  | 'bad-nonce'

export type DecodeFramesResult =
  | { ok: true; frames: Frame[] }
  | { ok: false; code: 'ELM_BAD_FRAME'; reason: FrameRejectReason; frameIndex: number }

/** Ошибка кодирования: собственный кадр не удовлетворяет формату — это баг вызывающего. */
export class FrameError extends Error {
  override readonly name = 'FrameError'
  readonly code = 'ELM_BAD_FRAME' as const
  readonly reason: FrameRejectReason
  readonly frameIndex: number
  constructor(reason: FrameRejectReason, frameIndex: number) {
    super(`bad frame [${frameIndex}]: ${reason}`)
    this.reason = reason
    this.frameIndex = frameIndex
  }
}

/** Размер пакета в байтах для готового списка кадров. */
export function packetByteLength(frames: readonly Frame[]): number {
  let n = PACKET_HEADER_BYTES
  for (const f of frames) n += FRAME_HEADER_BYTES + f.payload.length
  return n
}

function startsWithEl1(p: Uint8Array): boolean {
  return p.length >= 3 && p[0] === EL1[0] && p[1] === EL1[1] && p[2] === EL1[2]
}

function checkFrame(f: Frame, i: number, direction: FrameDirection | undefined): void {
  if (!Number.isInteger(f.seq) || f.seq < 0 || f.seq > SAFE_MAX) throw new FrameError('seq-unsafe', i)
  if (!Number.isInteger(f.ts) || f.ts < 0 || f.ts > SAFE_MAX) throw new FrameError('ts-unsafe', i)
  if (f.clientId.length !== CLIENT_ID_BYTES) throw new FrameError('bad-client-id', i)
  if (!Number.isInteger(f.clientSeq) || f.clientSeq < 0 || f.clientSeq > U32_MAX) {
    throw new FrameError('bad-client-seq', i)
  }
  if (f.payload.length > C.MAX_DELTA_BYTES) throw new FrameError('delta-too-large', i)
  if (!startsWithEl1(f.payload)) throw new FrameError('not-el1', i)
  if (direction === 'c2s') {
    if (f.seq !== 0) throw new FrameError('seq-not-zero', i)
    if (f.ts !== 0) throw new FrameError('ts-not-zero', i)
  }
}

/**
 * Кодирует пакет. Бросает FrameError, если кадры не удовлетворяют формату:
 * на стороне отправителя это ошибка программиста, а не входные данные.
 */
export function encodeFrames(frames: readonly Frame[], opts: FrameCodecOptions = {}): Uint8Array {
  if (frames.length > C.MAX_FRAMES) throw new FrameError('too-many-frames', frames.length)

  let payloadTotal = 0
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    if (f === undefined) throw new FrameError('truncated', i)
    checkFrame(f, i, opts.direction)
    payloadTotal += f.payload.length
    if (payloadTotal > C.MAX_PACKET_BYTES) throw new FrameError('packet-too-large', i)
  }

  const out = new Uint8Array(PACKET_HEADER_BYTES + frames.length * FRAME_HEADER_BYTES + payloadTotal)
  const view = new DataView(out.buffer)
  out[0] = PACKET_MAGIC
  out[1] = PACKET_VERSION
  view.setUint16(2, frames.length, true)

  let o = PACKET_HEADER_BYTES
  for (const f of frames) {
    view.setBigUint64(o, BigInt(f.seq), true)
    out.set(f.clientId, o + 8)
    view.setUint32(o + 16, f.clientSeq, true)
    view.setBigUint64(o + 20, BigInt(f.ts), true)
    view.setUint32(o + 28, f.payload.length, true)
    out.set(f.payload, o + FRAME_HEADER_BYTES)
    o += FRAME_HEADER_BYTES + f.payload.length
  }
  return out
}

function reject(reason: FrameRejectReason, frameIndex: number): DecodeFramesResult {
  return { ok: false, code: 'ELM_BAD_FRAME', reason, frameIndex }
}

/**
 * Разбирает пакет. Никогда не бросает: любая порча входа возвращается кодом ELM_BAD_FRAME.
 * Payload копируется — вызывающий волен держать входной буфер сколько угодно.
 */
export function decodeFrames(bytes: Uint8Array, opts: FrameCodecOptions = {}): DecodeFramesResult {
  if (bytes.length < PACKET_HEADER_BYTES) return reject('short-header', -1)
  if (bytes[0] !== PACKET_MAGIC) return reject('bad-magic', -1)
  if (bytes[1] !== PACKET_VERSION) return reject('bad-version', -1)

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(2, true)
  if (count > C.MAX_FRAMES) return reject('too-many-frames', -1)

  const maxPacket =
    PACKET_HEADER_BYTES + C.MAX_FRAMES * FRAME_HEADER_BYTES + C.MAX_PACKET_BYTES
  if (bytes.length > maxPacket) return reject('packet-too-large', -1)

  const frames: Frame[] = []
  let o = PACKET_HEADER_BYTES
  let payloadTotal = 0

  for (let i = 0; i < count; i++) {
    if (o + FRAME_HEADER_BYTES > bytes.length) return reject('truncated', i)

    const seqBig = view.getBigUint64(o, true)
    if (seqBig > BigInt(SAFE_MAX)) return reject('seq-unsafe', i)
    const tsBig = view.getBigUint64(o + 20, true)
    if (tsBig > BigInt(SAFE_MAX)) return reject('ts-unsafe', i)

    const seq = Number(seqBig)
    const ts = Number(tsBig)
    const clientSeq = view.getUint32(o + 16, true)
    const len = view.getUint32(o + 28, true)

    if (len > C.MAX_DELTA_BYTES) return reject('delta-too-large', i)
    payloadTotal += len
    if (payloadTotal > C.MAX_PACKET_BYTES) return reject('packet-too-large', i)

    const start = o + FRAME_HEADER_BYTES
    const end = start + len
    if (end > bytes.length) return reject('truncated', i)

    const payload = bytes.slice(start, end)
    if (!startsWithEl1(payload)) return reject('not-el1', i)

    if (opts.direction === 'c2s') {
      if (seq !== 0) return reject('seq-not-zero', i)
      if (ts !== 0) return reject('ts-not-zero', i)
    }

    frames.push({ seq, clientId: bytes.slice(o + 8, o + 16), clientSeq, ts, payload })
    o = end
  }

  if (o !== bytes.length) return reject('trailing-bytes', count)
  return { ok: true, frames }
}

/** Быстрая проверка без сборки объектов: годится ли пакет вообще. */
export function isValidPacket(bytes: Uint8Array, opts: FrameCodecOptions = {}): boolean {
  return decodeFrames(bytes, opts).ok
}

/**
 * AAD пакета (§4.4): всегда 16 байт "EL1"(3) ‖ type(1) ‖ docIdBytes(12).
 * Связывает шифротекст с версией протокола, типом и документом.
 */
export function buildAadBytes(type: PacketType, docIdBytes: Uint8Array): Uint8Array {
  if (docIdBytes.length !== C.DOC_ID_BYTES) throw new FrameError('bad-doc-id', -1)
  const aad = new Uint8Array(C.AAD_BYTES)
  aad[0] = EL1[0]
  aad[1] = EL1[1]
  aad[2] = EL1[2]
  aad[3] = type
  aad.set(docIdBytes, 4)
  return aad
}

export interface Envelope {
  type: PacketType
  /** 12 байт: sessionTag(8) ‖ counter(4, big-endian). */
  nonce: Uint8Array
  /** ciphertext ‖ tag(16). */
  body: Uint8Array
}

/** Собирает EL1-конверт: "EL1"(3) ‖ type(1) ‖ nonce(12) ‖ ciphertext‖tag. */
export function encodeEnvelope(e: Envelope): Uint8Array {
  if (e.nonce.length !== C.NONCE_BYTES) throw new FrameError('bad-nonce', -1)
  const out = new Uint8Array(C.HEADER_BYTES + e.body.length)
  out[0] = EL1[0]
  out[1] = EL1[1]
  out[2] = EL1[2]
  out[3] = e.type
  out.set(e.nonce, 4)
  out.set(e.body, C.HEADER_BYTES)
  return out
}

/** Разбирает EL1-конверт. Любая порча → null, без исключений. */
export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  if (bytes.length < C.HEADER_BYTES + C.GCM_TAG_BYTES) return null
  if (!startsWithEl1(bytes)) return null
  const type = bytes[3]
  if (type === undefined || !isPacketType(type)) return null
  return {
    type,
    nonce: bytes.slice(4, C.HEADER_BYTES),
    body: bytes.slice(C.HEADER_BYTES),
  }
}
