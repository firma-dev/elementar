import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  C,
  CLIENT_ID_BYTES,
  FRAME_HEADER_BYTES,
  PACKET_HEADER_BYTES,
  PACKET_MAGIC,
  PACKET_VERSION,
  PacketType,
  buildAadBytes,
  decodeEnvelope,
  decodeFrames,
  encodeEnvelope,
  encodeFrames,
  packetByteLength,
} from '../src/index.js'
import type { Frame } from '../src/index.js'

function payload(n: number, fill = 0x2a): Uint8Array {
  const p = new Uint8Array(Math.max(3, n))
  p[0] = 0x45
  p[1] = 0x4c
  p[2] = 0x31
  p.fill(fill, 3)
  return p
}

function frame(over: Partial<Frame> = {}): Frame {
  return {
    seq: 0,
    clientId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    clientSeq: 0,
    ts: 0,
    payload: payload(16),
    ...over,
  }
}

function expectFrames(bytes: Uint8Array): Frame[] {
  const r = decodeFrames(bytes)
  if (!r.ok) throw new Error(`unexpected reject: ${r.reason}`)
  return r.frames
}

describe('транспортный кадр: round-trip', () => {
  it('пустой пакет кодируется и разбирается', () => {
    const bytes = encodeFrames([])
    expect(bytes.length).toBe(PACKET_HEADER_BYTES)
    expect(bytes[0]).toBe(PACKET_MAGIC)
    expect(bytes[1]).toBe(PACKET_VERSION)
    expect(expectFrames(bytes)).toEqual([])
  })

  it('раскладка заголовка совпадает с §8.4', () => {
    const f = frame({ seq: 0x0102030405, clientSeq: 7, ts: 1_700_000_000_000 })
    const bytes = encodeFrames([f])
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(2, true)).toBe(1)
    expect(Number(view.getBigUint64(PACKET_HEADER_BYTES, true))).toBe(f.seq)
    expect(bytes.slice(PACKET_HEADER_BYTES + 8, PACKET_HEADER_BYTES + 16)).toEqual(f.clientId)
    expect(view.getUint32(PACKET_HEADER_BYTES + 16, true)).toBe(7)
    expect(Number(view.getBigUint64(PACKET_HEADER_BYTES + 20, true))).toBe(f.ts)
    expect(view.getUint32(PACKET_HEADER_BYTES + 28, true)).toBe(f.payload.length)
    expect(bytes.length).toBe(packetByteLength([f]))
  })

  it('round-trip на случайных кадрах', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seq: fc.integer({ min: 0, max: 2 ** 40 }),
            clientId: fc.uint8Array({ minLength: 8, maxLength: 8 }),
            clientSeq: fc.integer({ min: 0, max: 0xffff_ffff }),
            ts: fc.integer({ min: 0, max: 2 ** 42 }),
            payloadLen: fc.integer({ min: 3, max: 300 }),
            fill: fc.integer({ min: 0, max: 255 }),
          }),
          { maxLength: 20 },
        ),
        (raw) => {
          const frames: Frame[] = raw.map((r) => ({
            seq: r.seq,
            clientId: r.clientId,
            clientSeq: r.clientSeq,
            ts: r.ts,
            payload: payload(r.payloadLen, r.fill),
          }))
          const back = expectFrames(encodeFrames(frames))
          expect(back).toEqual(frames)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('payload копируется, а не ссылается на входной буфер', () => {
    const bytes = encodeFrames([frame()])
    const got = expectFrames(bytes)
    bytes.fill(0, PACKET_HEADER_BYTES + FRAME_HEADER_BYTES)
    expect(got[0]?.payload[0]).toBe(0x45)
  })

  it('работает на view со сдвигом byteOffset', () => {
    const bytes = encodeFrames([frame({ clientSeq: 9 })])
    const backing = new Uint8Array(bytes.length + 5)
    backing.set(bytes, 5)
    const view = backing.subarray(5)
    expect(expectFrames(view)[0]?.clientSeq).toBe(9)
  })
})

describe('транспортный кадр: битые данные дают ELM_BAD_FRAME, а не исключение', () => {
  const bad = (bytes: Uint8Array): string => {
    const r = decodeFrames(bytes)
    expect(r.ok).toBe(false)
    return r.ok ? '' : r.reason
  }

  it('пустой вход и обрезанный заголовок', () => {
    expect(bad(new Uint8Array(0))).toBe('short-header')
    expect(bad(new Uint8Array([0xe1, 0x01, 0x00]))).toBe('short-header')
  })

  it('чужой magic и чужая версия', () => {
    const ok = encodeFrames([frame()])
    const m = ok.slice()
    m[0] = 0xe2
    expect(bad(m)).toBe('bad-magic')
    const v = ok.slice()
    v[1] = 0x02
    expect(bad(v)).toBe('bad-version')
  })

  it('count больше MAX_FRAMES', () => {
    const b = new Uint8Array(PACKET_HEADER_BYTES)
    b[0] = PACKET_MAGIC
    b[1] = PACKET_VERSION
    new DataView(b.buffer).setUint16(2, C.MAX_FRAMES + 1, true)
    expect(bad(b)).toBe('too-many-frames')
  })

  it('count врёт: кадров меньше, чем объявлено', () => {
    const ok = encodeFrames([frame()])
    new DataView(ok.buffer).setUint16(2, 2, true)
    expect(bad(ok)).toBe('truncated')
  })

  it('обрезанный payload', () => {
    const ok = encodeFrames([frame()])
    expect(bad(ok.slice(0, ok.length - 1))).toBe('truncated')
  })

  it('хвостовой мусор после последнего кадра', () => {
    const ok = encodeFrames([frame()])
    const withTail = new Uint8Array(ok.length + 3)
    withTail.set(ok)
    expect(bad(withTail)).toBe('trailing-bytes')
  })

  it('len больше MAX_DELTA_BYTES', () => {
    const ok = encodeFrames([frame()])
    new DataView(ok.buffer).setUint32(PACKET_HEADER_BYTES + 28, C.MAX_DELTA_BYTES + 1, true)
    expect(bad(ok)).toBe('delta-too-large')
  })

  it('payload не начинается с EL1', () => {
    const ok = encodeFrames([frame()])
    ok[PACKET_HEADER_BYTES + FRAME_HEADER_BYTES] = 0x00
    expect(bad(ok)).toBe('not-el1')
  })

  it('seq и ts вне безопасного диапазона', () => {
    const ok = encodeFrames([frame()])
    const s = ok.slice()
    new DataView(s.buffer).setBigUint64(PACKET_HEADER_BYTES, 0xffff_ffff_ffff_ffffn, true)
    expect(bad(s)).toBe('seq-unsafe')
    const t = ok.slice()
    new DataView(t.buffer).setBigUint64(PACKET_HEADER_BYTES + 20, 0xffff_ffff_ffff_ffffn, true)
    expect(bad(t)).toBe('ts-unsafe')
  })

  it('сумма len больше MAX_PACKET_BYTES', () => {
    const many = Array.from({ length: 17 }, () => frame({ payload: payload(C.MAX_DELTA_BYTES) }))
    expect(() => encodeFrames(many)).toThrow(/packet-too-large/)
  })

  it('декодер отбивает пакет, чей суммарный payload больше MAX_PACKET_BYTES', () => {
    const n = 17
    const len = C.MAX_DELTA_BYTES
    const out = new Uint8Array(PACKET_HEADER_BYTES + n * (FRAME_HEADER_BYTES + len))
    const view = new DataView(out.buffer)
    out[0] = PACKET_MAGIC
    out[1] = PACKET_VERSION
    view.setUint16(2, n, true)
    let o = PACKET_HEADER_BYTES
    for (let i = 0; i < n; i++) {
      view.setUint32(o + 28, len, true)
      out.set(payload(3), o + FRAME_HEADER_BYTES)
      o += FRAME_HEADER_BYTES + len
    }
    expect(n * len).toBeGreaterThan(C.MAX_PACKET_BYTES)
    expect(bad(out)).toBe('packet-too-large')
  })

  it('направление c2s требует seq=0 и ts=0', () => {
    const ok = encodeFrames([frame({ seq: 5, ts: 1 })])
    const r = decodeFrames(ok, { direction: 'c2s' })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toBe('seq-not-zero')
    expect(decodeFrames(encodeFrames([frame()]), { direction: 'c2s' }).ok).toBe(true)
    expect(() => encodeFrames([frame({ ts: 1 })], { direction: 'c2s' })).toThrow(/ts-not-zero/)
  })

  it('никакой случайный мусор не роняет декодер', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(() => decodeFrames(bytes)).not.toThrow()
      }),
      { numRuns: 500 },
    )
  })

  it('порча валидного пакета в любом байте не роняет декодер', () => {
    const ok = encodeFrames([frame({ seq: 3, ts: 4 }), frame({ clientSeq: 2 })])
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: ok.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (i, delta) => {
          const copy = ok.slice()
          copy[i] = ((copy[i] ?? 0) + delta) & 0xff
          expect(() => decodeFrames(copy)).not.toThrow()
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('кодирование: собственные кадры валидируются', () => {
  it('clientId ровно 8 байт', () => {
    expect(() => encodeFrames([frame({ clientId: new Uint8Array(7) })])).toThrow(/bad-client-id/)
    expect(CLIENT_ID_BYTES).toBe(8)
  })

  it('payload обязан быть EL1-пакетом и влезать в MAX_DELTA_BYTES', () => {
    expect(() => encodeFrames([frame({ payload: new Uint8Array([1, 2, 3]) })])).toThrow(/not-el1/)
    expect(() => encodeFrames([frame({ payload: payload(C.MAX_DELTA_BYTES + 1) })])).toThrow(
      /delta-too-large/,
    )
  })

  it('больше MAX_FRAMES кадров не кодируется', () => {
    const many = Array.from({ length: C.MAX_FRAMES + 1 }, () => frame())
    expect(() => encodeFrames(many)).toThrow(/too-many-frames/)
  })
})

describe('конверт EL1 и AAD', () => {
  it('AAD = EL1 ‖ type ‖ docId, ровно 16 байт', () => {
    const docId = new Uint8Array(12).fill(9)
    const aad = buildAadBytes(PacketType.Snapshot, docId)
    expect(aad.length).toBe(C.AAD_BYTES)
    expect([...aad.slice(0, 4)]).toEqual([0x45, 0x4c, 0x31, 0x02])
    expect(aad.slice(4)).toEqual(docId)
    expect(() => buildAadBytes(PacketType.OpBatch, new Uint8Array(11))).toThrow(/bad-doc-id/)
  })

  it('round-trip конверта', () => {
    const nonce = new Uint8Array(12).fill(3)
    const body = new Uint8Array(40).fill(7)
    const e = encodeEnvelope({ type: PacketType.OpBatch, nonce, body })
    expect(e.length).toBe(C.HEADER_BYTES + body.length)
    expect(decodeEnvelope(e)).toEqual({ type: PacketType.OpBatch, nonce, body })
  })

  it('битый конверт даёт null', () => {
    expect(decodeEnvelope(new Uint8Array(4))).toBeNull()
    const e = encodeEnvelope({
      type: PacketType.OpBatch,
      nonce: new Uint8Array(12),
      body: new Uint8Array(16),
    })
    const badType = e.slice()
    badType[3] = 0x7f
    expect(decodeEnvelope(badType)).toBeNull()
    const badMagic = e.slice()
    badMagic[0] = 0x00
    expect(decodeEnvelope(badMagic)).toBeNull()
  })
})
