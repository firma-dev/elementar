/**
 * Открытие базы и лестница миграций (§7.1).
 * Если открытие упало — база НЕ трётся: поднимается аварийный режим, документ читается
 * из снапшота в памяти, UI предлагает экспорт.
 */
import { DB_NAME, IDB_MIGRATIONS, IDB_VERSION } from './schema.js'
import type { StoreName } from './schema.js'

export type IdbErrorReason = 'blocked' | 'open-failed' | 'upgrade-failed' | 'tx-failed' | 'unsupported'

export class IdbError extends Error {
  override readonly name = 'IdbError'
  readonly reason: IdbErrorReason

  constructor(reason: IdbErrorReason, message?: string, options?: { cause?: unknown }) {
    super(message ?? reason, options)
    this.reason = reason
  }
}

export type OpenResult = { ok: true; db: IDBDatabase } | { ok: false; error: IdbError }

export interface OpenOptions {
  name?: string
  version?: number
  factory?: IDBFactory
  /** Другая вкладка держит старую версию: молча не ждём вечно. */
  onBlocked?(): void
  /** База выселена сервером хранилища или пользователем. */
  onClose?(): void
}

function factoryOf(opts: OpenOptions): IDBFactory {
  const f = opts.factory ?? globalThis.indexedDB
  if (f === undefined || f === null) throw new IdbError('unsupported', 'IndexedDB is not available')
  return f
}

/** Прогон миграций от `from` (эксклюзивно) до конца лестницы. */
export function runMigrations(db: IDBDatabase, tx: IDBTransaction, from: number): void {
  for (let v = from; v < IDB_MIGRATIONS.length; v++) {
    const step = IDB_MIGRATIONS[v]
    if (step !== undefined) step(db, tx)
  }
}

export function openDb(opts: OpenOptions = {}): Promise<IDBDatabase> {
  const name = opts.name ?? DB_NAME
  const version = opts.version ?? IDB_VERSION
  const idb = factoryOf(opts)
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = idb.open(name, version)
    } catch (cause) {
      reject(new IdbError('open-failed', 'indexedDB.open threw', { cause }))
      return
    }
    request.onupgradeneeded = (event: IDBVersionChangeEvent): void => {
      const db = request.result
      const tx = request.transaction
      if (tx === null) {
        reject(new IdbError('upgrade-failed', 'no upgrade transaction'))
        return
      }
      try {
        runMigrations(db, tx, Math.max(0, event.oldVersion))
      } catch (cause) {
        tx.abort()
        reject(new IdbError('upgrade-failed', 'migration threw', { cause }))
      }
    }
    request.onblocked = (): void => {
      opts.onBlocked?.()
    }
    request.onerror = (): void => {
      reject(new IdbError('open-failed', String(request.error?.message ?? 'open failed')))
    }
    request.onsuccess = (): void => {
      const db = request.result
      db.onclose = (): void => {
        opts.onClose?.()
      }
      db.onversionchange = (): void => {
        db.close()
        opts.onClose?.()
      }
      resolve(db)
    }
  })
}

/** Открытие без исключений: вызывающий поднимает аварийный режим, а не падает. */
export async function tryOpenDb(opts: OpenOptions = {}): Promise<OpenResult> {
  try {
    return { ok: true, db: await openDb(opts) }
  } catch (e) {
    return { ok: false, error: e instanceof IdbError ? e : new IdbError('open-failed', String(e)) }
  }
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result)
    request.onerror = (): void =>
      reject(new IdbError('tx-failed', String(request.error?.message ?? 'request failed')))
  })
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve()
    tx.onabort = (): void =>
      reject(new IdbError('tx-failed', String(tx.error?.message ?? 'transaction aborted')))
    tx.onerror = (): void =>
      reject(new IdbError('tx-failed', String(tx.error?.message ?? 'transaction failed')))
  })
}

/**
 * Транзакция целиком: обработчик получает готовые сторы и не ждёт промисов чужих
 * микротасков — иначе IDB закроет транзакцию под ногами.
 */
export async function withTx<T>(
  db: IDBDatabase,
  stores: StoreName | readonly StoreName[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  const names = typeof stores === 'string' ? [stores] : [...stores]
  const tx = db.transaction(names, mode)
  const done = txDone(tx)
  let out: T
  try {
    out = await fn(tx)
  } catch (e) {
    try {
      tx.abort()
    } catch {
      /* уже завершена */
    }
    throw e
  }
  await done
  return out
}

export async function getAll<T>(
  tx: IDBTransaction,
  store: StoreName,
  query?: IDBKeyRange | IDBValidKey,
  count?: number,
): Promise<T[]> {
  const s = tx.objectStore(store)
  return req<T[]>(s.getAll(query ?? null, count) as IDBRequest<T[]>)
}

export async function getAllFromIndex<T>(
  tx: IDBTransaction,
  store: StoreName,
  index: string,
  query?: IDBKeyRange | IDBValidKey,
  count?: number,
): Promise<T[]> {
  const s = tx.objectStore(store).index(index)
  return req<T[]>(s.getAll(query ?? null, count) as IDBRequest<T[]>)
}

export async function getOne<T>(
  tx: IDBTransaction,
  store: StoreName,
  key: IDBValidKey,
): Promise<T | undefined> {
  return req<T | undefined>(tx.objectStore(store).get(key) as IDBRequest<T | undefined>)
}

export function put(tx: IDBTransaction, store: StoreName, value: unknown): Promise<IDBValidKey> {
  return req(tx.objectStore(store).put(value as never))
}

export function del(tx: IDBTransaction, store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  return req(tx.objectStore(store).delete(key)) as Promise<void>
}

/** Диапазон всех ключей одного документа для составного keyPath [docId, …]. */
export function docRange(docId: string): IDBKeyRange {
  return IDBKeyRange.bound([docId], [docId, []], false, false)
}
