/**
 * DocDO (§8.3, §8.7): единственный владелец правды о документе. HTTP-часть — в doc.http.ts,
 * здесь остаётся то, что бывает только внутри DO: WebSocket с хибернацией, alarm, storage.
 * Без state.acceptWebSocket проект не существует экономически (§8.3), поэтому сокеты
 * только хибернируемые.
 */
import {
  C,
  PATHS,
  PRESENCE_CT_BYTES,
  WS_AUTO_PING,
  WS_AUTO_PONG,
  WS_PROTOCOL,
  b32CharLen,
  decodeFrames,
  encodeFrames,
  encodeMsg,
  parseClientMsg,
  parseWsSubprotocols,
} from '@elementar/proto'
import type {
  DocId,
  ElmErrorCode,
  Frame,
  PeerInfo,
  ServerMsg,
  SnapshotResult,
} from '@elementar/proto'
import type { Env } from '../env.js'
import { jsonResponse } from '../http/cors.js'
import { errorResponse, notFoundResponse } from '../http/errors.js'
import { decodeB32Exact } from '../lib/b32.js'
import { D1Catalog } from '../lib/catalog.js'
import { R2Blobs } from '../lib/r2.js'
import { DocCore } from './doc.core.js'
import { CODE_HEADER, DOC_ID_HEADER, handleDocHttp } from './doc.http.js'
import type { DocHooks } from './doc.http.js'
import { SqlDocStore } from './doc.store.js'

export { CODE_HEADER, DOC_ID_HEADER } from './doc.http.js'

const ALARM_MS = 60_000
const PEER_TIMEOUT_MS = 60_000
const COMPACT_WAIT_MS = 60_000
const WS_CATCHUP_BATCH = 128
const CLIENT_ID_BYTES = 8
const PRESENCE_CT_CHARS = b32CharLen(PRESENCE_CT_BYTES)

interface Attachment {
  sessionId: string
  clientIdB32: string
  since: number
  connectedAt: number
}

export class DocDO implements DurableObject {
  private core: DocCore | null = null
  private docIdValue: DocId | null = null
  private readonly presence = new Map<string, string | null>()
  private compactAskedAt = 0
  private compactAskedTo: string | null = null
  private pending = { deltasIn: 0, bytesIn: 0, wsOpens: 0, compactions: 0 }

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private coreFor(docId: DocId): DocCore {
    if (this.core !== null && this.docIdValue === docId) return this.core
    this.docIdValue = docId
    this.core = new DocCore({
      docId,
      store: new SqlDocStore(this.ctx.storage.sql),
      blobs: new R2Blobs(this.env.SNAPSHOTS),
      catalog: new D1Catalog(this.env.DB),
      now: () => Date.now(),
    })
    return this.core
  }

  async fetch(request: Request): Promise<Response> {
    const docIdRaw = request.headers.get(DOC_ID_HEADER)
    if (docIdRaw === null) return notFoundResponse(this.env.ELM_ALLOWED_ORIGIN)
    const docId = docIdRaw as DocId
    const core = this.coreFor(docId)
    const url = new URL(request.url)

    // служебные вызовы кронов: снаружи недостижимы, подписи не требуют
    if (url.pathname === '/_destroy') {
      this.closeAll('ELM_NOT_FOUND')
      core.destroy()
      await this.ctx.storage.deleteAll()
      return jsonResponse({ ok: true }, 200, {}, this.env.ELM_ALLOWED_ORIGIN)
    }
    if (url.pathname === '/_flush') {
      await core.flush()
      return jsonResponse({ ok: true }, 200, {}, this.env.ELM_ALLOWED_ORIGIN)
    }

    if (url.pathname === PATHS.ws(docId)) return this.upgrade(request, core, docId)

    await this.armAlarm()
    return handleDocHttp(core, request, docId, this.env.ELM_ALLOWED_ORIGIN, this.hooks())
  }

  private hooks(): DocHooks {
    return {
      broadcastDeltas: (frames, assigned) => this.broadcastAccepted(frames, assigned, null),
      broadcastSnapshot: (res: SnapshotResult) => {
        this.pending.compactions += 1
        this.compactAskedTo = null
        this.broadcast(
          { t: 'snapshot', snapshotSeq: res.snapshotSeq, snapshotGen: res.snapshotGen },
          null,
        )
      },
      closeAll: (code) => this.closeAll(code),
      onPush: (accepted, bytes) => {
        this.pending.deltasIn += accepted
        this.pending.bytesIn += bytes
      },
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private async upgrade(request: Request, core: DocCore, docId: DocId): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return this.fail('ELM_BAD_REQUEST', 'Expected websocket upgrade')
    }
    const hs = parseWsSubprotocols(request.headers.get('sec-websocket-protocol'))
    if (hs === null) return this.fail('ELM_SIG_MISSING', 'Signature required')

    const sigErr = await core.verifySig({
      method: 'GET',
      path: PATHS.ws(docId),
      body: new Uint8Array(0),
      sig: hs.sig,
    })
    if (sigErr !== null) return this.fail(sigErr, 'Signature rejected')
    if (!core.visible()) return this.fail('ELM_NOT_FOUND', 'Not found')
    if (this.ctx.getWebSockets().length >= C.MAX_PEERS) {
      return this.fail('ELM_RATE_LIMITED', 'Too many peers')
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const sessionId = randomSessionId()
    const att: Attachment = {
      sessionId,
      clientIdB32: hs.clientIdB32,
      since: hs.since,
      connectedAt: Date.now(),
    }
    this.ctx.acceptWebSocket(server, [sessionId])
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_AUTO_PING, WS_AUTO_PONG))
    server.serializeAttachment(att)
    this.pending.wsOpens += 1
    core.touch()
    await this.armAlarm()

    const m = core.row
    const welcome: ServerMsg = {
      t: 'welcome',
      head: core.head(),
      snapshotSeq: m?.snapshotSeq ?? 0,
      snapshotGen: m?.snapshotGen ?? 0,
      sessionId,
      peers: this.peers(sessionId),
      compactionNeeded: core.compactionNeeded(),
      safeCompactSeq: core.safeCompactSeq(),
      serverTime: Date.now(),
    }
    server.send(encodeMsg(welcome))
    this.catchUp(server, core, hs.since)
    this.broadcast({ t: 'peer', ev: 'join', peer: this.peerInfo(att) }, sessionId)

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'sec-websocket-protocol': WS_PROTOCOL },
    })
  }

  /** since ≥ snapshotSeq — досылаем кадры пачками по 128; иначе resync (§8.7). */
  private catchUp(ws: WebSocket, core: DocCore, since: number): void {
    const m = core.row
    if (m === null) return
    if (since < m.snapshotSeq) {
      ws.send(encodeMsg({ t: 'resync', snapshotSeq: m.snapshotSeq, reason: 'behind-snapshot' }))
      return
    }
    let cursor = since
    for (;;) {
      const res = core.getDeltas({ since: cursor, limit: WS_CATCHUP_BATCH })
      if (!res.ok) {
        ws.send(encodeMsg({ t: 'resync', snapshotSeq: m.snapshotSeq, reason: 'log-pruned' }))
        return
      }
      const frames = decodeFrames(res.value.packet)
      if (!frames.ok || frames.frames.length === 0) return
      ws.send(res.value.packet)
      const last = frames.frames[frames.frames.length - 1]
      if (last === undefined) return
      cursor = last.seq
      if (!res.value.more) return
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null
    const docId = this.docIdValue
    if (att === null || docId === null) {
      ws.close(1011, 'no session')
      return
    }
    const core = this.coreFor(docId)
    if (!core.visible()) {
      ws.send(encodeMsg({ t: 'bye', code: 'ELM_NOT_FOUND' }))
      ws.close(1000, 'gone')
      return
    }

    if (typeof message !== 'string') {
      const decoded = decodeFrames(new Uint8Array(message), { direction: 'c2s' })
      if (!decoded.ok) {
        ws.send(encodeMsg({ t: 'error', code: 'ELM_BAD_FRAME', message: decoded.reason }))
        return
      }
      const res = core.pushDeltas(decoded.frames)
      if (!res.ok) {
        ws.send(encodeMsg({ t: 'error', code: res.code, message: res.message }))
        return
      }
      this.pending.deltasIn += res.value.accepted
      this.pending.bytesIn += message.byteLength
      ws.send(
        encodeMsg({
          t: 'ack',
          assigned: res.value.assigned,
          head: res.value.head,
          duplicates: res.value.duplicates,
          compactionNeeded: res.value.compactionNeeded,
          safeCompactSeq: res.value.safeCompactSeq,
        }),
      )
      this.broadcastAccepted(decoded.frames, res.value.assigned, att.sessionId)
      await this.armAlarm()
      return
    }

    const msg = parseClientMsg(message)
    if (msg === null) {
      ws.send(encodeMsg({ t: 'error', code: 'ELM_BAD_REQUEST', message: 'Bad control frame' }))
      return
    }
    switch (msg.t) {
      case 'sub':
        this.catchUp(ws, core, msg.since)
        return
      case 'ack': {
        const clientId = decodeB32Exact(att.clientIdB32, CLIENT_ID_BYTES)
        if (clientId !== null) core.ack(clientId, msg.upto)
        return
      }
      case 'pres': {
        if (msg.ct !== null && msg.ct.length > PRESENCE_CT_CHARS) return
        this.presence.set(att.sessionId, msg.ct)
        this.broadcast({ t: 'peer', ev: 'pres', peer: this.peerInfo(att) }, att.sessionId)
        return
      }
      case 'snapshot-ready':
        // компактор отчитался: ждём PUT /snapshot, следующий опрос — только по таймауту
        this.compactAskedAt = Date.now()
        return
      case 'bye':
        ws.close(1000, 'bye')
        return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null
    if (att !== null) {
      this.presence.delete(att.sessionId)
      this.broadcast({ t: 'peer', ev: 'leave', peer: this.peerInfo(att) }, att.sessionId)
    }
    await this.armAlarm()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }

  // ── alarm: флаш, чистка nonce, выселение пиров, пороги компакции ──────────

  async alarm(): Promise<void> {
    const docId = this.docIdValue
    if (docId === null) return
    const core = this.coreFor(docId)

    core.pruneNonces()
    this.evictSilentPeers()
    if (core.dirty) await core.flush()
    await this.flushMetrics()
    this.askCompaction(core)

    // пока sig_nonces непуста, alarm перевзводится обязательно (§8.3)
    const keepAlive = this.ctx.getWebSockets().length > 0 || core.dirty || core.hasNonces()
    if (keepAlive) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS)
  }

  private async armAlarm(): Promise<void> {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS)
  }

  private evictSilentPeers(): void {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const beat = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      const att = ws.deserializeAttachment() as Attachment | null
      const last = beat?.getTime() ?? att?.connectedAt ?? now
      if (now - last > PEER_TIMEOUT_MS) {
        try {
          ws.close(1001, 'timeout')
        } catch {
          // сокет уже мёртв — ничего страшного
        }
        if (att !== null) this.presence.delete(att.sessionId)
      }
    }
  }

  /**
   * Выбор компактора детерминирован (§8.9 п.2): пир с наибольшим СЕРВЕРНЫМ ack,
   * при равенстве — подключившийся раньше. При hard просим всех сразу.
   */
  private askCompaction(core: DocCore): void {
    const urgency = core.compactionUrgency()
    if (urgency === 'none') {
      this.compactAskedTo = null
      return
    }
    const now = Date.now()
    if (this.compactAskedTo !== null && now - this.compactAskedAt < COMPACT_WAIT_MS) return

    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return

    const stats = core.logStats()
    const msg: ServerMsg = {
      t: 'compact-request',
      upto: core.safeCompactSeq(),
      logCount: stats.count,
      logBytes: stats.bytes,
      urgency,
    }

    if (urgency === 'hard') {
      this.broadcast(msg, null)
      this.compactAskedAt = now
      this.compactAskedTo = 'all'
      return
    }

    const acked = new Map<string, number>()
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att === null) continue
      const id = decodeB32Exact(att.clientIdB32, CLIENT_ID_BYTES)
      if (id !== null) acked.set(att.clientIdB32, core.ackedFor(id))
    }
    const ranked = sockets
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment | null }))
      .filter((p): p is { ws: WebSocket; att: Attachment } => p.att !== null)
      .sort((a, b) => {
        const d = (acked.get(b.att.clientIdB32) ?? 0) - (acked.get(a.att.clientIdB32) ?? 0)
        return d !== 0 ? d : a.att.connectedAt - b.att.connectedAt
      })
    const skip = this.compactAskedTo
    const target = ranked.find((p) => p.att.sessionId !== skip) ?? ranked[0]
    if (target === undefined) return
    target.ws.send(encodeMsg(msg))
    this.compactAskedAt = now
    this.compactAskedTo = target.att.sessionId
  }

  private async flushMetrics(): Promise<void> {
    const p = this.pending
    if (p.deltasIn === 0 && p.bytesIn === 0 && p.wsOpens === 0 && p.compactions === 0) return
    const day = new Date().toISOString().slice(0, 10)
    const cat = new D1Catalog(this.env.DB)
    this.pending = { deltasIn: 0, bytesIn: 0, wsOpens: 0, compactions: 0 }
    const jobs: Array<Promise<void>> = []
    if (p.deltasIn > 0) jobs.push(cat.bumpMetric(day, 'deltas_in', p.deltasIn))
    if (p.bytesIn > 0) jobs.push(cat.bumpMetric(day, 'bytes_in', p.bytesIn))
    if (p.wsOpens > 0) jobs.push(cat.bumpMetric(day, 'ws_opens', p.wsOpens))
    if (p.compactions > 0) jobs.push(cat.bumpMetric(day, 'compactions', p.compactions))
    await Promise.all(jobs).catch(() => undefined)
  }

  // ── вспомогательное ───────────────────────────────────────────────────────

  private peers(exceptSessionId: string | null): PeerInfo[] {
    const out: PeerInfo[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att === null || att.sessionId === exceptSessionId) continue
      out.push(this.peerInfo(att))
    }
    return out
  }

  private peerInfo(att: Attachment): PeerInfo {
    return {
      sessionId: att.sessionId,
      pres: this.presence.get(att.sessionId) ?? null,
      since: Math.max(0, Date.now() - att.connectedAt),
    }
  }

  private broadcast(msg: ServerMsg, exceptSessionId: string | null): void {
    const text = encodeMsg(msg)
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att === null || att.sessionId === exceptSessionId) continue
      try {
        ws.send(text)
      } catch {
        // закрывшийся сокет не должен ронять рассылку
      }
    }
  }

  private broadcastAccepted(
    frames: readonly Frame[],
    assigned: ReadonlyArray<{ clientSeq: number; seq: number }>,
    exceptSessionId: string | null,
  ): void {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return
    const now = Date.now()
    const bySeq = new Map(assigned.map((a) => [a.clientSeq, a.seq]))
    const out: Frame[] = []
    for (const f of frames) {
      const seq = bySeq.get(f.clientSeq)
      if (seq === undefined) continue
      out.push({ seq, clientId: f.clientId, clientSeq: f.clientSeq, ts: now, payload: f.payload })
    }
    if (out.length === 0) return
    const packet = encodeFrames(out)
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att === null || att.sessionId === exceptSessionId) continue
      try {
        ws.send(packet)
      } catch {
        // см. broadcast
      }
    }
  }

  private closeAll(code: ElmErrorCode): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(encodeMsg({ t: 'bye', code }))
        ws.close(1000, code)
      } catch {
        // сокет мог закрыться сам
      }
    }
  }

  private fail(code: ElmErrorCode, message: string): Response {
    const res = errorResponse(code, message, {}, this.env.ELM_ALLOWED_ORIGIN)
    const headers = new Headers(res.headers)
    headers.set(CODE_HEADER, code)
    return new Response(res.body, { status: res.status, headers })
  }
}

function randomSessionId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
