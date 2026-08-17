/**
 * Склейка repo ↔ transport ↔ doc (§7.3–§7.6).
 *
 * Решения принимает автомат (`machine.ts`), здесь исполняются его эффекты: сокет, очередь,
 * снапшоты, keepalive-флаш, присутствие и сводка. Всё асинхронное — только тут.
 */
import { C, PacketType, decodeFrames } from '@elementar/proto'
import type { ElmErrorCode, ServerMsg } from '@elementar/proto'
import { computed, signal } from '@preact/signals-core'
import type { ReadonlySignal } from '@preact/signals-core'
import { b32encode } from '../crypto/b32.js'
import { openPacket, sealPacket } from '../crypto/envelope.js'
import type { DocKeyInput } from '../crypto/envelope.js'
import type { NonceSource } from '../crypto/nonce.js'
import { signWsHandshake } from '../crypto/sign.js'
import type { Signer } from '../crypto/sign.js'
import type { ChangeSet } from '../doc/apply.js'
import type { DocCore } from '../doc/handle.js'
import { canonicalizeFull } from '../doc/state.js'
import type { DocState } from '../doc/state.js'
import type { CollectionsDef } from '../schema/types.js'
import { opTarget } from '../ops/types.js'
import type { AnyOp, Op } from '../ops/types.js'
import { shouldSnapshot } from '../ops/compact.js'
import { debounce } from '../util/batch.js'
import { fromUtf8 } from '../util/bytes.js'
import type { DocRepo } from '../storage/repo.js'
import type { OutboxRow } from '../storage/schema.js'
import { createProposalStore, pruneExpiredProposals } from '../proposals/store.js'
import type { ProposalStore } from '../proposals/store.js'
import {
  advanceChain,
  emptyChain,
  encodeBatchPlaintext,
  decodeBatchPlaintext,
  headOfBatch,
  verifyChain,
  ChainWatch,
} from './chain.js'
import type { ChainState, DecryptedBatch } from './chain.js'
import { buildDigest } from './digest.js'
import type { CatchupDigest } from './digest.js'
import {
  HttpError,
  armBeacon,
  flushOutboxBeacon,
  getDeltas,
  getSnapshot,
  prepareBeacon,
  pushDeltas,
  putSnapshot,
} from './http.js'
import type { FetchLike, HttpEnv } from './http.js'
import { initialState, reduce, statusOf } from './machine.js'
import type { Effect, MachineState, SyncEvent, SyncStatus } from './machine.js'
import { WS_LIMITS, createOutbox } from './outbox.js'
import type { Outbox } from './outbox.js'
import { PresenceTracker, adoptPeers, openPresence, sealPresence } from './presence.js'
import type { PresencePayload, PresenceView } from './presence.js'
import { createTransport, wsUrl } from './transport.js'
import type { Transport, WsFactory } from './transport.js'

export interface SessionEnv<S extends CollectionsDef> {
  core: DocCore<S>
  repo: DocRepo
  docId: string
  docIdBytes: Uint8Array
  /** K_doc: им шифруются все пакеты документа. */
  key: DocKeyInput
  nonce: NonceSource
  signer: Signer
  /** 8 байт, уникален на пару (устройство, документ). */
  clientId: Uint8Array
  sync?: boolean
  base?: string
  wsUrl?: string
  fetch?: FetchLike
  ws?: WsFactory
  now?(): number
  rnd?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  /** Слушать visibilitychange/pagehide/online (в тестах — выключено). */
  listen?: boolean
}

export interface Session {
  readonly status: ReadonlySignal<SyncStatus>
  readonly digest: ReadonlySignal<CatchupDigest | null>
  readonly presence: ReadonlySignal<readonly PresencePayload[]>
  readonly proposals: ProposalStore
  readonly machine: MachineState
  start(): Promise<void>
  dispatch(event: SyncEvent): void
  setEnabled(on: boolean): void
  setPresence(view: PresenceView, editing: string | null): Promise<void>
  /** Отправить всё, что готово, прямо сейчас. */
  flush(): Promise<void>
  /** Записать локальный снапшот (§7.2). */
  snapshot(): Promise<void>
  close(): Promise<void>
}

/** Серверный код ошибки → событие автомата. */
export function eventForCode(code: ElmErrorCode | 'ELM_NETWORK', at: number, retryAfterMs?: number): SyncEvent {
  switch (code) {
    case 'ELM_NOT_FOUND':
    case 'ELM_SIG_INVALID':
    case 'ELM_SIG_MISSING':
    case 'ELM_CHALLENGE':
    case 'ELM_EXISTS':
      return { t: 'ERR_AUTH', at }
    case 'ELM_RATE_LIMITED':
      return retryAfterMs === undefined
        ? { t: 'ERR_RATE', at }
        : { t: 'ERR_RATE', at, retryAfterMs }
    case 'ELM_FROZEN':
      return { t: 'ERR_RATE', at, retryAfterMs: retryAfterMs ?? C.BACKOFF_MAX_MS }
    default:
      return { t: 'ERR_OTHER', at, code }
  }
}

export function createSession<S extends CollectionsDef>(env: SessionEnv<S>): Session {
  const now = env.now ?? Date.now
  const rnd = env.rnd ?? Math.random
  const setT = env.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms))
  const clearT = env.clearTimer ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>))

  const httpEnv: HttpEnv = {
    docId: env.docId,
    docIdBytes: env.docIdBytes,
    signer: env.signer,
    clientId: env.clientId,
    ...(env.base === undefined ? {} : { base: env.base }),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  }

  const outbox: Outbox = createOutbox({
    repo: env.repo,
    docId: env.docId,
    clientId: env.clientId,
    now,
    rnd,
    onDead: (rows) => {
      void env.repo.journal({
        at: now(),
        kind: 'outbox-dead',
        docId: env.docId,
        message: `Не удалось отправить ${rows.length} правок`,
      })
    },
  })

  let machine: MachineState = initialState({ syncEnabled: env.sync ?? true })
  const status = signal<SyncStatus>(statusOf(machine, now()))
  const digestSignal = signal<CatchupDigest | null>(null)
  const presenceSignal = signal<readonly PresencePayload[]>([])
  const peers = new PresenceTracker()
  const chainWatch = new ChainWatch()

  let chain: ChainState = emptyChain()
  let transport: Transport | null = null
  let timer: unknown = null
  let presenceTimer: unknown = null
  let sending = false
  let sendAgain = false
  let closed = false
  let bytesSinceSnapshot = 0
  let lastSnapshotSeq = 0
  let catchupChanges: ChangeSet[] = []
  let lastOnlineAt = 0
  /** Записи, которые правил я — для пометки conflictedWithMine в сводке (§6.12). */
  const myTouched = new Set<string>()
  let lastPresence: PresenceView = { kind: 'today' }
  let offListeners: Array<() => void> = []

  const publish = (): void => {
    status.value = { ...statusOf(machine, now()), chainWarning: machine.chainWarning || chainWatch.warning }
  }

  // ——— локальные правки ———

  /** Пачка своих операций: цепочка, шифрование, лог и очередь — за одну транзакцию. */
  const queueLocal = async (ops: readonly Op[]): Promise<void> => {
    if (ops.length === 0) return
    const prevHead = chain.head
    const plaintext = encodeBatchPlaintext(prevHead, ops)
    const ct = await sealPacket({
      key: env.key,
      type: PacketType.OpBatch,
      docIdBytes: env.docIdBytes,
      nonce: env.nonce.next(),
      plaintext,
    })
    const clientSeq = await env.repo.nextClientSeq(env.docId)
    const id = ops[0]?.i
    if (id === undefined) return
    await env.repo.commitLocal({
      docId: env.docId,
      ops,
      outbox: [{ i: id, ct: b32encode(ct), clientSeq }],
      now: now(),
    })
    for (const op of ops) {
      const target = opTarget(op)
      if (target !== null) myTouched.add(target.r)
    }
    chain = { head: headOfBatch(prevHead, ops), bySeq: chain.bySeq }
    bytesSinceSnapshot += plaintext.length
    dispatch({ t: 'LOCAL_OP', at: now(), count: 1 })
    void rearmBeacon()
    scheduleSnapshot()
  }

  const rearmBeacon = async (): Promise<void> => {
    try {
      const rows = await outbox.all()
      armBeacon(env.docId, await prepareBeacon(httpEnv, rows, env.clientId, now()))
    } catch {
      armBeacon(env.docId, null)
    }
  }

  // ——— входящие ———

  const openBatch = async (payload: Uint8Array, seq: number): Promise<DecryptedBatch | null> => {
    try {
      const opened = await openPacket({
        key: env.key,
        docIdBytes: env.docIdBytes,
        packet: payload,
        expectType: PacketType.OpBatch,
      })
      const decoded = decodeBatchPlaintext(opened.plaintext)
      if (decoded === null) return null
      return { seq, prevHead: decoded.prevHead, ops: decoded.ops }
    } catch {
      return null
    }
  }

  const applyBatches = async (batches: DecryptedBatch[]): Promise<void> => {
    if (batches.length === 0) return
    const verdict = verifyChain(chain, batches)
    if (!verdict.ok) {
      await env.repo.journal({
        at: now(),
        kind: 'chain',
        docId: env.docId,
        message:
          verdict.kind === 'gap'
            ? 'Сервер отдаёт неполную историю'
            : 'Расхождение хеш-цепочки лога',
        data: { atSeq: verdict.atSeq },
      })
      dispatch({ t: 'ERR_CHAIN', at: now() })
      return
    }
    chain = advanceChain(chain, batches)
    const ops: AnyOp[] = []
    const rows: Array<{ i: string; seq: number }> = []
    for (const b of batches) {
      for (const op of b.ops) {
        ops.push(op)
        rows.push({ i: op.i, seq: b.seq })
      }
    }
    const changes = env.core.applyRemote(ops)
    catchupChanges.push(changes)
    await env.repo.appendOps(env.docId, ops, now())
    await env.repo.markOpsSeq(env.docId, rows)
    const upto = batches.reduce((m, b) => Math.max(m, b.seq), 0)
    bytesSinceSnapshot += ops.length * 128
    dispatch({ t: 'OPS', at: now(), count: ops.length, upto })
    scheduleSnapshot()
  }

  const onBinary = async (bytes: Uint8Array): Promise<void> => {
    const decoded = decodeFrames(bytes, { direction: 's2c' })
    if (!decoded.ok) {
      dispatch({ t: 'ERR_OTHER', at: now(), code: 'ELM_BAD_FRAME', message: decoded.reason })
      return
    }
    const batches: DecryptedBatch[] = []
    for (const frame of decoded.frames) {
      const b = await openBatch(frame.payload, frame.seq)
      if (b !== null) batches.push(b)
    }
    await applyBatches(batches)
  }

  const onServerMsg = async (msg: ServerMsg): Promise<void> => {
    switch (msg.t) {
      case 'welcome': {
        dispatch({
          t: 'WELCOME',
          at: now(),
          head: msg.head,
          snapshotSeq: msg.snapshotSeq,
          peers: msg.peers.length,
          compactionNeeded: msg.compactionNeeded,
          safeCompactSeq: msg.safeCompactSeq,
        })
        transport?.send({ t: 'sub', since: machine.since })
        await adoptPeers(peers, msg.peers, (ct) =>
          openPresence({ key: env.key, docIdBytes: env.docIdBytes, ct }),
        )
        presenceSignal.value = peers.payloads(now())
        startPresenceBeat()
        break
      }
      case 'ack': {
        const acked = await outbox.ack(msg.assigned)
        const pending = await outbox.count()
        dispatch({ t: 'ACK', at: now(), acked, head: msg.head, pending })
        if (pending === 0 && machine.phase === 'catchup') dispatch({ t: 'DRAINED', at: now() })
        // очередь длиннее одной пачки: продолжаем сразу после подтверждения
        if (pending > 0) void sendPending()
        void rearmBeacon()
        break
      }
      case 'resync': {
        await doResync()
        break
      }
      case 'snapshot': {
        // чужая компакция: наш локальный лог всё ещё валиден, но снапшот стоит перечитать
        if (msg.snapshotSeq > machine.since) await doResync()
        break
      }
      case 'peer': {
        if (msg.ev === 'leave') peers.remove(msg.peer.sessionId)
        else if (msg.peer.pres !== null) {
          const payload = await openPresence({
            key: env.key,
            docIdBytes: env.docIdBytes,
            ct: msg.peer.pres,
          })
          if (payload !== null) {
            peers.put(msg.peer.sessionId, payload, now())
            const warned = chainWatch.note({
              mine: chain.head,
              theirs: payload.chainHead,
              outboxEmpty: machine.pending === 0,
              now: now(),
            })
            if (warned) dispatch({ t: 'ERR_CHAIN', at: now() })
          }
        }
        presenceSignal.value = peers.payloads(now())
        publish()
        break
      }
      case 'compact-request': {
        if (msg.urgency === 'hard') await pushSnapshot(msg.upto)
        break
      }
      case 'error': {
        dispatch(eventForCode(msg.code, now(), msg.retryAfter === undefined ? undefined : msg.retryAfter * 1000))
        break
      }
      case 'bye': {
        dispatch(eventForCode(msg.code, now(), msg.retryAfter === undefined ? undefined : msg.retryAfter * 1000))
        break
      }
      default:
        break
    }
  }

  // ——— HTTP-пути ———

  const decodeSnapshot = async (ct: Uint8Array): Promise<DocState | null> => {
    try {
      const opened = await openPacket({
        key: env.key,
        docIdBytes: env.docIdBytes,
        packet: ct,
        expectType: PacketType.Snapshot,
      })
      const parsed: unknown = JSON.parse(fromUtf8(opened.plaintext))
      if (typeof parsed !== 'object' || parsed === null) return null
      const state = parsed as DocState
      return state.v === 1 ? state : null
    } catch {
      return null
    }
  }

  /** Локальное состояние отстало от серверного снапшота: забрать и слить (§7.6 шаг 9). */
  const doResync = async (): Promise<void> => {
    try {
      const ct = await getSnapshot(httpEnv)
      const remote = await decodeSnapshot(ct)
      if (remote === null) return
      env.core.mergeRemote(remote)
      chain = emptyChain(remote.chainHead)
      dispatch({ t: 'OPS', at: now(), count: 0, upto: remote.seq })
      await pullDeltas(remote.seq)
    } catch (e) {
      handleHttpError(e)
    }
  }

  const pullDeltas = async (since: number): Promise<void> => {
    let cursor = since
    for (let page = 0; page < 64; page++) {
      const res = await getDeltas(httpEnv, { since: cursor, limit: 128 })
      const batches: DecryptedBatch[] = []
      for (const frame of res.frames) {
        const b = await openBatch(frame.payload, frame.seq)
        if (b !== null) batches.push(b)
        cursor = Math.max(cursor, frame.seq)
      }
      await applyBatches(batches)
      if (!res.more || res.frames.length === 0) break
    }
    dispatch({ t: 'DRAINED', at: now() })
  }

  const pushSnapshot = async (baseSeq: number): Promise<void> => {
    const state = env.core._state.value
    const ct = await sealPacket({
      key: env.key,
      type: PacketType.Snapshot,
      docIdBytes: env.docIdBytes,
      nonce: env.nonce.next(),
      plaintext: canonicalizeFull({ ...state, seq: baseSeq, chainHead: chain.head }),
    })
    try {
      const res = await putSnapshot(httpEnv, ct, baseSeq)
      transport?.send({ t: 'snapshot-ready', baseSeq: res.snapshotSeq, bytes: res.bytes })
      await writeLocalSnapshot(res.snapshotSeq)
    } catch (e) {
      handleHttpError(e)
    }
  }

  const handleHttpError = (e: unknown): void => {
    if (!(e instanceof HttpError)) {
      dispatch({ t: 'ERR_OTHER', at: now(), message: String(e) })
      return
    }
    if (e.code === 'ELM_STALE_BASE' || e.code === 'ELM_UNSAFE_BASE') {
      void doResync()
      return
    }
    dispatch(eventForCode(e.code, now(), e.retryAfter ?? undefined))
  }

  // ——— снапшоты ———

  const writeLocalSnapshot = async (seq: number = machine.since): Promise<void> => {
    const base = env.core._state.value
    const pruned = pruneExpiredProposals(base, now())
    const state: DocState = { ...pruned, seq, chainHead: chain.head, applied: 0 }
    await env.repo.putSnapshot(env.docId, seq, state, { savedAt: now() })
    bytesSinceSnapshot = 0
    lastSnapshotSeq = seq
  }

  const snapshotDebounced = debounce(() => {
    void writeLocalSnapshot().catch(() => undefined)
  }, C.SNAPSHOT_DEBOUNCE_MS)

  const scheduleSnapshot = (): void => {
    if (!shouldSnapshot(env.core._state.value, bytesSinceSnapshot)) return
    snapshotDebounced()
  }

  // ——— присутствие ———

  const sendPresence = async (): Promise<void> => {
    if (transport === null || machine.phase !== 'live') return
    const payload: PresencePayload = {
      actor: env.core.actor,
      view: lastPresence,
      editing: null,
      chainHead: chain.head,
      at: now(),
    }
    const ct = await sealPresence({
      key: env.key,
      docIdBytes: env.docIdBytes,
      nonce: env.nonce,
      payload,
    })
    if (ct !== null) transport.send({ t: 'pres', ct })
  }

  const startPresenceBeat = (): void => {
    if (presenceTimer !== null) clearT(presenceTimer)
    const beat = (): void => {
      presenceTimer = setT(() => {
        void sendPresence()
        peers.prune(now())
        presenceSignal.value = peers.payloads(now())
        beat()
      }, C.PRESENCE_BEAT_MS)
    }
    beat()
  }

  const stopPresenceBeat = (): void => {
    if (presenceTimer !== null) clearT(presenceTimer)
    presenceTimer = null
  }

  // ——— отправка ———

  const sendPending = async (): Promise<void> => {
    if (closed) return
    if (sending) {
      sendAgain = true
      return
    }
    sending = true
    try {
      let rows: OutboxRow[] = await outbox.take(WS_LIMITS, now())
      while (rows.length > 0) {
        const packet = outbox.packet(rows)
        const live = transport !== null && transport.phase === 'open'
        if (live && transport?.sendBinary(packet) === true) break // ack придёт сообщением
        try {
          const res = await pushDeltas(httpEnv, packet)
          const acked = await outbox.ack(res.assigned)
          const pending = await outbox.count()
          dispatch({ t: 'ACK', at: now(), acked, head: res.head, pending })
          if (res.compactionNeeded && res.safeCompactSeq > lastSnapshotSeq) {
            await pushSnapshot(res.safeCompactSeq)
          }
        } catch (e) {
          await outbox.fail(rows, now())
          handleHttpError(e)
          break
        }
        rows = await outbox.take(WS_LIMITS, now())
      }
      void rearmBeacon()
    } finally {
      sending = false
      if (sendAgain) {
        sendAgain = false
        void sendPending()
      }
    }
  }

  // ——— эффекты автомата ———

  const connect = async (since: number): Promise<void> => {
    try {
      const handshake = await signWsHandshake(env.signer, {
        docId: env.docId,
        docIdBytes: env.docIdBytes,
        since,
        clientId: env.clientId,
      })
      const t = createTransport({
        url: env.wsUrl ?? wsUrl(env.docId),
        handshake,
        now,
        ...(env.ws === undefined ? {} : { ws: env.ws }),
        ...(env.setTimer === undefined ? {} : { setTimer: env.setTimer }),
        ...(env.clearTimer === undefined ? {} : { clearTimer: env.clearTimer }),
      })
      transport = t
      t.on('open', () => dispatch({ t: 'SOCK_OPEN', at: now() }))
      t.on('msg', (m) => {
        void onServerMsg(m)
      })
      t.on('binary', (b) => {
        void onBinary(b)
      })
      t.on('close', () => {
        stopPresenceBeat()
        peers.clear()
        presenceSignal.value = []
        if (transport === t) transport = null
        dispatch({ t: 'SOCK_CLOSE', at: now() })
      })
      t.connect()
    } catch (e) {
      dispatch({ t: 'ERR_OTHER', at: now(), message: String(e) })
    }
  }

  const runEffect = (fx: Effect): void => {
    switch (fx.e) {
      case 'connect':
        void connect(fx.since)
        break
      case 'disconnect': {
        stopPresenceBeat()
        const t = transport
        transport = null
        t?.close(1000, fx.reason)
        break
      }
      case 'send':
        void sendPending()
        break
      case 'schedule': {
        if (timer !== null) clearT(timer)
        const delay = Math.max(0, fx.at - now())
        timer = setT(() => {
          timer = null
          dispatch({ t: 'TIMER', at: now() })
        }, delay)
        break
      }
      case 'cancel':
        if (timer !== null) clearT(timer)
        timer = null
        break
      case 'persist':
        void env.repo
          .patchDoc(env.docId, { seq: machine.since, lastOpenedAt: now() })
          .catch(() => undefined)
        if (machine.phase === 'live') lastOnlineAt = now()
        break
      case 'flushHttp': {
        void (async (): Promise<void> => {
          const rows = await outbox.all()
          flushOutboxBeacon(env.docId, rows)
        })()
        break
      }
      case 'resync':
        void doResync()
        break
      case 'digest': {
        digestSignal.value = buildDigest(catchupChanges, env.core._state.value, env.core.actor, {
          since: lastOnlineAt,
          mine: myTouched,
        })
        catchupChanges = []
        myTouched.clear()
        break
      }
    }
  }

  function dispatch(event: SyncEvent): void {
    if (closed && event.t !== 'CLOSE') return
    const r = reduce(machine, event, { rnd })
    machine = r.state
    publish()
    for (const fx of r.effects) runEffect(fx)
  }

  // ——— проводка ———

  const offLocal = env.core.onLocalOps((ops) => {
    void queueLocal(ops).catch(() => undefined)
  })

  const proposals = createProposalStore({
    state: env.core._state,
    actor: env.core.actor,
    tick: () => env.core.clock.tick(),
    commit: (ops) => {
      // принятие предложения — правка человека: применяется локально и уходит в синк
      env.core.applyRemote(ops)
      void queueLocal(ops).catch(() => undefined)
    },
    now,
  })

  const attachListeners = (): void => {
    if (env.listen === false) return
    const doc = (globalThis as { document?: Document }).document
    const win = (globalThis as { addEventListener?: typeof addEventListener }).addEventListener
    if (doc !== undefined) {
      const onVis = (): void => {
        dispatch({ t: doc.visibilityState === 'hidden' ? 'HIDDEN' : 'VISIBLE', at: now() })
      }
      doc.addEventListener('visibilitychange', onVis)
      offListeners.push(() => doc.removeEventListener('visibilitychange', onVis))
    }
    if (win !== undefined) {
      const onHide = (): void => dispatch({ t: 'PAGEHIDE', at: now() })
      const onOnline = (): void => dispatch({ t: 'NET_ONLINE', at: now() })
      const onOffline = (): void => dispatch({ t: 'NET_OFFLINE', at: now() })
      globalThis.addEventListener('pagehide', onHide)
      globalThis.addEventListener('online', onOnline)
      globalThis.addEventListener('offline', onOffline)
      offListeners.push(() => globalThis.removeEventListener('pagehide', onHide))
      offListeners.push(() => globalThis.removeEventListener('online', onOnline))
      offListeners.push(() => globalThis.removeEventListener('offline', onOffline))
    }
  }

  return {
    status: computed(() => status.value),
    digest: computed(() => digestSignal.value),
    presence: computed(() => presenceSignal.value),
    proposals,

    get machine(): MachineState {
      return machine
    },

    async start(): Promise<void> {
      const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator
      const online = nav?.onLine ?? true
      dispatch({ t: 'OPEN', at: now(), sync: env.sync ?? true, online })
      const snap = await env.repo.latestSnapshot(env.docId)
      if (snap !== undefined) {
        env.core.setState(snap.state)
        chain = emptyChain(snap.state.chainHead)
        lastSnapshotSeq = snap.seq
      }
      const tail = await env.repo.opsAfter(env.docId, snap?.seq ?? 0)
      if (tail.length > 0) env.core.applyRemote(tail.map((r) => r.op))
      const pending = await outbox.count()
      const card = await env.repo.getDoc(env.docId)
      lastOnlineAt = card?.lastOpenedAt ?? now()
      attachListeners()
      void rearmBeacon()
      dispatch({ t: 'LOADED', at: now(), since: card?.seq ?? snap?.seq ?? 0, pending })
    },

    dispatch,

    setEnabled(on): void {
      dispatch({ t: on ? 'ENABLE_SYNC' : 'DISABLE_SYNC', at: now() })
    },

    async setPresence(view, editing): Promise<void> {
      lastPresence = view
      if (transport === null || machine.phase !== 'live') return
      const payload: PresencePayload = {
        actor: env.core.actor,
        view,
        editing,
        chainHead: chain.head,
        at: now(),
      }
      const ct = await sealPresence({
        key: env.key,
        docIdBytes: env.docIdBytes,
        nonce: env.nonce,
        payload,
      })
      if (ct !== null) transport.send({ t: 'pres', ct })
    },

    async flush(): Promise<void> {
      await sendPending()
    },

    async snapshot(): Promise<void> {
      snapshotDebounced.cancel()
      await writeLocalSnapshot()
    },

    async close(): Promise<void> {
      dispatch({ t: 'CLOSE', at: now() })
      closed = true
      offLocal()
      for (const off of offListeners) off()
      offListeners = []
      stopPresenceBeat()
      if (timer !== null) clearT(timer)
      timer = null
      snapshotDebounced.flush()
      armBeacon(env.docId, null)
    },
  }
}
