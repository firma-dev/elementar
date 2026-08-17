import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { PacketType, SIZES, decodeEnvelope } from '@elementar/proto'
import {
  EnvelopeError,
  PAD_MAX_BYTES,
  bucketSize,
  importAesKey,
  openPacket,
  padPlaintext,
  sealPacket,
  sealedSize,
  tryOpenPacket,
  unpadPlaintext,
} from '../../src/crypto/envelope.js'
import { createNonceSource } from '../../src/crypto/nonce.js'
import { generateDocKey } from '../../src/crypto/keys.js'

const DOC_A = Uint8Array.from({ length: 12 }, (_, i) => i)
const DOC_B = Uint8Array.from({ length: 12 }, (_, i) => i + 1)
const utf8 = new TextEncoder()

async function ctx() {
  const key = await importAesKey(generateDocKey())
  return { key, nonces: createNonceSource() }
}

describe('конверт EL1', () => {
  it('корзины паддинга считаются по §4.6', () => {
    expect(bucketSize(0)).toBe(256)
    expect(bucketSize(255)).toBe(256)
    expect(bucketSize(256)).toBe(512)
    expect(bucketSize(4095)).toBe(4096)
    expect(bucketSize(4096)).toBe(8192)
    expect(bucketSize(65535)).toBe(65536)
    expect(bucketSize(65536)).toBe(131072)
    expect(bucketSize(1_000_000)).toBe(1_048_576)
  })

  it('паддинг ISO/IEC 7816-4 обратим', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (data) => {
        const padded = padPlaintext(data, 'on')
        expect(padded.length).toBe(bucketSize(1 + data.length))
        expect([...unpadPlaintext(padded)]).toEqual([...data])
      }),
      { numRuns: 200 },
    )
    const text = utf8.encode('купить молоко')
    const noPad = padPlaintext(text, 'off')
    expect(noPad.length).toBe(1 + text.length)
    expect([...unpadPlaintext(noPad)]).toEqual([...utf8.encode('купить молоко')])
  })

  it('битый паддинг — ошибка, а не молчаливое усечение', () => {
    const padded = padPlaintext(utf8.encode('x'), 'on')
    padded.fill(0, 1)
    expect(() => unpadPlaintext(padded)).toThrowError(EnvelopeError)
    expect(() => unpadPlaintext(new Uint8Array(0))).toThrowError(EnvelopeError)
    const badFlag = padPlaintext(utf8.encode('x'), 'on')
    badFlag[0] = 0x7f
    expect(() => unpadPlaintext(badFlag)).toThrowError(EnvelopeError)
  })

  it('round-trip: разные размеры и типы пакетов', async () => {
    const { key, nonces } = await ctx()
    for (const size of [0, 1, 17, 255, 4096, 70_000]) {
      const plaintext = Uint8Array.from({ length: size }, (_, i) => (i * 31) & 0xff)
      const packet = await sealPacket({
        key,
        type: PacketType.OpBatch,
        docIdBytes: DOC_A,
        nonce: nonces.next(),
        plaintext,
      })
      expect(packet.length).toBe(sealedSize(size))
      const opened = await openPacket({ key, docIdBytes: DOC_A, packet })
      expect(opened.type).toBe(PacketType.OpBatch)
      expect([...opened.plaintext]).toEqual([...plaintext])
    }
  })

  it('заголовок совпадает с §4.4: EL1, type, nonce', async () => {
    const { key, nonces } = await ctx()
    const nonce = nonces.next()
    const packet = await sealPacket({
      key,
      type: PacketType.Snapshot,
      docIdBytes: DOC_A,
      nonce,
      plaintext: utf8.encode('состояние'),
    })
    expect([...packet.slice(0, 3)]).toEqual([...utf8.encode('EL1')])
    expect(packet[3]).toBe(PacketType.Snapshot)
    const env = decodeEnvelope(packet)
    expect(env).not.toBeNull()
    expect([...(env as { nonce: Uint8Array }).nonce]).toEqual([...nonce])
    expect(packet.length).toBeGreaterThan(SIZES.HEADER_BYTES + SIZES.GCM_TAG_BYTES)
  })

  it('подмена docId в AAD ломает расшифровку', async () => {
    const { key, nonces } = await ctx()
    const packet = await sealPacket({
      key,
      type: PacketType.OpBatch,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('перенос блоба между документами'),
    })
    await expect(openPacket({ key, docIdBytes: DOC_B, packet })).rejects.toMatchObject({
      reason: 'auth-failed',
    })
    expect(await tryOpenPacket({ key, docIdBytes: DOC_B, packet })).toBeNull()
  })

  it('подмена типа пакета в AAD ломает расшифровку', async () => {
    const { key, nonces } = await ctx()
    const packet = await sealPacket({
      key,
      type: PacketType.OpBatch,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('нельзя подсунуть снапшот вместо оп-пакета'),
    })
    packet[3] = PacketType.Snapshot
    await expect(openPacket({ key, docIdBytes: DOC_A, packet })).rejects.toMatchObject({
      reason: 'auth-failed',
    })
  })

  it('подмена версии в заголовке ломает разбор', async () => {
    const { key, nonces } = await ctx()
    const packet = await sealPacket({
      key,
      type: PacketType.OpBatch,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('EL2 не бывает'),
    })
    packet[2] = 0x32 // 'EL2'
    await expect(openPacket({ key, docIdBytes: DOC_A, packet })).rejects.toMatchObject({
      reason: 'bad-packet',
    })
  })

  it('порча шифротекста и чужой ключ отбиваются тегом GCM', async () => {
    const { key, nonces } = await ctx()
    const packet = await sealPacket({
      key,
      type: PacketType.DocMeta,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('заголовок документа'),
    })
    const tampered = packet.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x01
    await expect(openPacket({ key, docIdBytes: DOC_A, packet: tampered })).rejects.toMatchObject({
      reason: 'auth-failed',
    })
    const foreign = await importAesKey(generateDocKey())
    await expect(openPacket({ key: foreign, docIdBytes: DOC_A, packet })).rejects.toMatchObject({
      reason: 'auth-failed',
    })
  })

  it('expectType отсекает чужой тип до расшифровки', async () => {
    const { key, nonces } = await ctx()
    const packet = await sealPacket({
      key,
      type: PacketType.Presence,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('присутствие'),
    })
    await expect(
      openPacket({ key, docIdBytes: DOC_A, packet, expectType: PacketType.OpBatch }),
    ).rejects.toMatchObject({ reason: 'wrong-type' })
  })

  it('паддинг скрывает разницу длин коротких правок', async () => {
    const { key, nonces } = await ctx()
    const a = await sealPacket({
      key,
      type: PacketType.OpBatch,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('купить молоко'),
    })
    const b = await sealPacket({
      key,
      type: PacketType.OpBatch,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext: utf8.encode('развод, делим квартиру на Профсоюзной'),
    })
    expect(a.length).toBe(b.length)
  })

  it('снапшоты больше 1 MiB идут без паддинга', async () => {
    const { key, nonces } = await ctx()
    const size = PAD_MAX_BYTES + 1
    expect(sealedSize(size)).toBe(SIZES.HEADER_BYTES + 1 + size + SIZES.GCM_TAG_BYTES)
    const plaintext = new Uint8Array(size)
    const packet = await sealPacket({
      key,
      type: PacketType.Snapshot,
      docIdBytes: DOC_A,
      nonce: nonces.next(),
      plaintext,
    })
    expect(packet.length).toBe(sealedSize(size))
    const opened = await openPacket({ key, docIdBytes: DOC_A, packet })
    expect(opened.plaintext).toHaveLength(size)
  })

  it('кривые аргументы отвергаются до крипты', async () => {
    const { key, nonces } = await ctx()
    await expect(
      sealPacket({
        key,
        type: PacketType.OpBatch,
        docIdBytes: new Uint8Array(11),
        nonce: nonces.next(),
        plaintext: new Uint8Array(1),
      }),
    ).rejects.toMatchObject({ reason: 'bad-doc-id' })
    await expect(
      sealPacket({
        key,
        type: PacketType.OpBatch,
        docIdBytes: DOC_A,
        nonce: new Uint8Array(8),
        plaintext: new Uint8Array(1),
      }),
    ).rejects.toMatchObject({ reason: 'bad-nonce' })
    await expect(importAesKey(new Uint8Array(16))).rejects.toMatchObject({ reason: 'bad-key' })
  })
})
