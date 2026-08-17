import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  C,
  CORS,
  HDR,
  UNSIGNED_PATHS,
  WS_PROTOCOL,
  encodeMsg,
  formatQuotaHeader,
  formatWsSubprotocols,
  parseClientMsg,
  parseQuotaHeader,
  parseServerMsg,
  parseWsSubprotocols,
} from '../src/index.js'
import type { ClientMsg, ServerMsg, WsHandshake } from '../src/index.js'

const peer = { sessionId: 'abc12345', pres: null, since: 0 }

describe('ClientMsg', () => {
  it('round-trip всех вариантов', () => {
    const msgs: ClientMsg[] = [
      { t: 'sub', since: 0 },
      { t: 'ack', upto: 42 },
      { t: 'pres', ct: null },
      { t: 'pres', ct: 'ABC123' },
      { t: 'snapshot-ready', baseSeq: 7, bytes: 1024 },
      { t: 'bye' },
    ]
    for (const m of msgs) expect(parseClientMsg(encodeMsg(m))).toEqual(m)
  })

  it('мусор отбивается', () => {
    const bads = [
      '',
      'null',
      '[]',
      '{"t":"nope"}',
      '{"t":"sub"}',
      '{"t":"sub","since":-1}',
      '{"t":"sub","since":1.5}',
      '{"t":"ack","upto":"5"}',
      '{"t":"pres"}',
      `{"t":"pres","ct":"${'A'.repeat(500)}"}`,
      '{"t":"pres","ct":"нет"}',
    ]
    for (const b of bads) expect(parseClientMsg(b)).toBeNull()
  })

  it('слишком длинный кадр отбивается по WS_FRAME_MAX', () => {
    expect(parseClientMsg(' '.repeat(C.WS_FRAME_MAX + 1))).toBeNull()
  })

  it('любая строка не роняет разбор', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseClientMsg(s)).not.toThrow()
      }),
      { numRuns: 300 },
    )
  })
})

describe('ServerMsg', () => {
  it('round-trip всех вариантов', () => {
    const msgs: ServerMsg[] = [
      {
        t: 'welcome',
        head: 10,
        snapshotSeq: 5,
        snapshotGen: 2,
        sessionId: 'sess1234',
        peers: [peer, { sessionId: 'p2', pres: 'ABC', since: 1000 }],
        compactionNeeded: false,
        safeCompactSeq: 5,
        serverTime: 1_700_000_000_000,
      },
      {
        t: 'ack',
        assigned: [{ clientSeq: 1, seq: 11 }],
        head: 11,
        duplicates: 0,
        compactionNeeded: true,
        safeCompactSeq: 4,
      },
      { t: 'resync', snapshotSeq: 5, reason: 'behind-snapshot' },
      { t: 'snapshot', snapshotSeq: 5, snapshotGen: 3 },
      { t: 'peer', ev: 'join', peer },
      { t: 'compact-request', upto: 9, logCount: 250, logBytes: 600_000, urgency: 'soft' },
      { t: 'error', code: 'ELM_BAD_FRAME', message: 'bad' },
      { t: 'error', code: 'ELM_RATE_LIMITED', message: 'slow', retryAfter: 30 },
      { t: 'bye', code: 'ELM_SHUTDOWN' },
      { t: 'bye', code: 'ELM_NOT_FOUND', retryAfter: 5 },
    ]
    for (const m of msgs) expect(parseServerMsg(encodeMsg(m))).toEqual(m)
  })

  it('клиент не доверяет серверу: битые поля → null', () => {
    const bads = [
      '{"t":"welcome"}',
      '{"t":"resync","snapshotSeq":1,"reason":"whatever"}',
      '{"t":"peer","ev":"join"}',
      '{"t":"peer","ev":"burn","peer":{"sessionId":"x","pres":null,"since":0}}',
      '{"t":"error","code":"ELM_WAT","message":"x"}',
      '{"t":"bye","code":"nope"}',
      '{"t":"compact-request","upto":1,"logCount":1,"logBytes":1,"urgency":"panic"}',
    ]
    for (const b of bads) expect(parseServerMsg(b)).toBeNull()
  })

  it('больше MAX_PEERS пиров в welcome — отказ', () => {
    const peers = Array.from({ length: C.MAX_PEERS + 1 }, (_, i) => ({
      sessionId: `s${i}`,
      pres: null,
      since: 0,
    }))
    const raw = JSON.stringify({
      t: 'welcome',
      head: 1,
      snapshotSeq: 0,
      snapshotGen: 0,
      sessionId: 's',
      peers,
      compactionNeeded: false,
      safeCompactSeq: 0,
      serverTime: 1,
    })
    expect(parseServerMsg(raw)).toBeNull()
  })
})

describe('субпротокол WS-хендшейка', () => {
  const h: WsHandshake = {
    since: 12,
    clientIdB32: '0123456789ABC',
    sig: { alg: 'ed25519', tsMs: 1_700_000_000_000, sigNonceB32: '0'.repeat(20), sigB32: 'Z'.repeat(103) },
  }

  it('round-trip через строку заголовка', () => {
    const tokens = formatWsSubprotocols(h)
    expect(tokens[0]).toBe(WS_PROTOCOL)
    expect(parseWsSubprotocols(tokens.join(', '))).toEqual(h)
    expect(parseWsSubprotocols(tokens)).toEqual(h)
  })

  it('без elm.v1, без подписи или с мусором — null', () => {
    const tokens = formatWsSubprotocols(h)
    expect(parseWsSubprotocols(tokens.slice(1).join(', '))).toBeNull()
    expect(parseWsSubprotocols(tokens.slice(0, 3).join(', '))).toBeNull()
    expect(parseWsSubprotocols('elm.v1, since.1, cl.0123456789ABC, sig.rsa.1.0.0')).toBeNull()
    expect(parseWsSubprotocols('elm.v1, since.x, cl.0123456789ABC, sig.ed25519.1.0.0')).toBeNull()
    expect(parseWsSubprotocols('elm.v1, since.1, cl.SHORT, sig.ed25519.1.0.0')).toBeNull()
    expect(parseWsSubprotocols(null)).toBeNull()
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseWsSubprotocols(s)).not.toThrow()
      }),
      { numRuns: 300 },
    )
  })
})

describe('заголовки HTTP', () => {
  it('имена в нижнем регистре и совпадают с CORS-списками', () => {
    for (const v of Object.values(HDR)) expect(v).toBe(v.toLowerCase())
    for (const h of [HDR.SIG, HDR.CLIENT, HDR.BASE_SEQ, HDR.CHALLENGE]) {
      expect(CORS.allowHeaders).toContain(h)
    }
    for (const h of [HDR.SEQ, HDR.GEN, HDR.HEAD, HDR.QUOTA, HDR.RETRY_AFTER, HDR.ETAG]) {
      expect(CORS.exposeHeaders).toContain(h)
    }
    expect(UNSIGNED_PATHS).toEqual(['/v1/health', '/v1/challenge'])
  })

  it('X-Elm-Quota round-trip', () => {
    const q = { logCount: 412, logLimit: 2000, bytes: 1_048_576, bytesLimit: 4_194_304 }
    expect(formatQuotaHeader(q)).toBe('log=412/2000;bytes=1048576/4194304')
    expect(parseQuotaHeader(formatQuotaHeader(q))).toEqual(q)
    expect(parseQuotaHeader('log=1/2')).toBeNull()
    expect(parseQuotaHeader(null)).toBeNull()
  })
})
