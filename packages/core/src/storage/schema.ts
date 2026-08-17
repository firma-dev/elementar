/**
 * Объектные хранилища IndexedDB (§7.1). Одна база на происхождение, версия — длина
 * лестницы миграций. Миграции только аддитивные и идемпотентные: стор никогда не удаляется
 * (Safari роняет onupgradeneeded на удалении).
 */
import type { SigAlg, WrapRecord } from '@elementar/proto'
import type { HlcString } from '../hlc.js'
import type { RecordId } from '../id.js'
import type { DocState } from '../doc/state.js'
import type { AnyOp } from '../ops/types.js'
import type { LinkPersistState } from '../crypto/link.js'

export const DB_NAME = 'elementar'

export const STORE = {
  docs: 'docs',
  snapshots: 'snapshots',
  ops: 'ops',
  outbox: 'outbox',
  secrets: 'secrets',
  blobs: 'blobs',
  settings: 'settings',
  journal: 'journal',
} as const

export type StoreName = (typeof STORE)[keyof typeof STORE]

export const STORE_NAMES: readonly StoreName[] = [
  STORE.docs,
  STORE.snapshots,
  STORE.ops,
  STORE.outbox,
  STORE.secrets,
  STORE.blobs,
  STORE.settings,
  STORE.journal,
]

export const IDX = {
  docsByOpened: 'by_opened',
  docsByCorpus: 'by_corpus',
  snapshotsByDoc: 'by_doc',
  opsBySeq: 'by_seq',
  outboxByNext: 'by_next',
  journalByTime: 'by_time',
} as const

/** Карточка документа: заголовок хранится локально открытым текстом (прихожая не расшифровывает). */
export interface DocRow {
  docId: string
  corpus: string
  title: string
  schemaVersion: number
  /** Последний серверный seq, вошедший в локальное состояние. */
  seq: number
  snapshotSeq: number
  lastOpenedAt: number
  createdAt: number
  pinned: boolean
  /** Настройка синка документа: выключенный документ живёт только локально. */
  sync: boolean
  linkPersistState: LinkPersistState
  /** Монотонный счётчик исходящих для (устройство, документ) — идемпотентность §7.4. */
  clientSeq: number
  app?: number
}

export interface SnapshotRow {
  docId: string
  seq: number
  /** structured clone, без JSON.stringify. */
  state: DocState
  savedAt: number
}

/** Хвост применённого лога: свои и чужие операции. `seq` появляется после подтверждения сервером. */
export interface OpRow {
  docId: string
  i: HlcString
  op: AnyOp
  seq?: number
  bytes: number
  at: number
}

/** Исходящая очередь (§7.4). `ct` — готовый EL1-пакет в base32. */
export interface OutboxItem {
  docId: string
  i: HlcString
  ct: string
  tries: number
  nextAt: number
}

export interface OutboxRow extends OutboxItem {
  clientSeq: number
  createdAt: number
  /** tries > OUTBOX_MAX_TRIES: элемент не выбрасывается, а показывается в «Что случилось». */
  dead?: boolean
}

export interface SecretsRow {
  docId: string
  mode: 'plain' | 'password'
  /** При mode: 'password' отсутствует, если человек не выбрал «запомнить на устройстве» (§5.4). */
  linkSecret?: ArrayBuffer
  wrap: WrapRecord
  wrapVer: number
  sigAlg: SigAlg
  /** 8 байт, уникален на пару (устройство, документ). */
  clientId?: ArrayBuffer
}

export interface BlobRow {
  docId: string
  blobId: string
  /** Шифротекст вложения, зеркало R2. */
  ct: ArrayBuffer
  bytes: number
  mime: string
  name: string
  savedAt: number
  uploaded: boolean
}

export interface SettingRow {
  key: string
  value: unknown
}

export type JournalKind =
  | 'open'
  | 'sync'
  | 'error'
  | 'chain'
  | 'quota'
  | 'outbox-dead'
  | 'export'
  | 'migrate'

export interface JournalRow {
  id?: number
  at: number
  kind: JournalKind
  message: string
  docId?: string
  data?: Record<string, unknown>
}

/** Экран «Что случилось» держит последние 200 событий. */
export const JOURNAL_LIMIT = 200

/** Удерживаются два последних снапшота: защита от сбоя записи. */
export const SNAPSHOT_KEEP = 2

/** Умерший элемент outbox: не выбрасывается, помечается (§7.4). */
export const OUTBOX_MAX_TRIES = 12

export type IdbMigration = (db: IDBDatabase, tx: IDBTransaction) => void

function ensureStore(
  db: IDBDatabase,
  tx: IDBTransaction,
  name: string,
  options: IDBObjectStoreParameters,
): IDBObjectStore {
  return db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, options)
}

function ensureIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
  options?: IDBIndexParameters,
): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options)
}

export const IDB_MIGRATIONS: readonly IdbMigration[] = [
  /* v1 */ (db, tx) => {
    const docs = ensureStore(db, tx, STORE.docs, { keyPath: 'docId' })
    ensureIndex(docs, IDX.docsByOpened, 'lastOpenedAt')
    ensureIndex(docs, IDX.docsByCorpus, 'corpus')

    const snapshots = ensureStore(db, tx, STORE.snapshots, { keyPath: ['docId', 'seq'] })
    ensureIndex(snapshots, IDX.snapshotsByDoc, 'docId')

    const ops = ensureStore(db, tx, STORE.ops, { keyPath: ['docId', 'i'] })
    ensureIndex(ops, IDX.opsBySeq, ['docId', 'seq'])

    const outbox = ensureStore(db, tx, STORE.outbox, { keyPath: ['docId', 'i'] })
    ensureIndex(outbox, IDX.outboxByNext, ['docId', 'nextAt'])

    ensureStore(db, tx, STORE.secrets, { keyPath: 'docId' })
    ensureStore(db, tx, STORE.blobs, { keyPath: ['docId', 'blobId'] })
    ensureStore(db, tx, STORE.settings, { keyPath: 'key' })

    const journal = ensureStore(db, tx, STORE.journal, { keyPath: 'id', autoIncrement: true })
    ensureIndex(journal, IDX.journalByTime, 'at')
  },
]

export const IDB_VERSION = IDB_MIGRATIONS.length

/** Ключ записи лога и outbox. */
export function opKey(docId: string, i: HlcString): [string, HlcString] {
  return [docId, i]
}

export function blobKey(docId: string, blobId: RecordId | string): [string, string] {
  return [docId, blobId]
}
