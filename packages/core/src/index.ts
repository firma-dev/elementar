/**
 * ВРЕМЕННЫЙ фасад @elementar/core (§7.7).
 *
 * Написан агентом приложения, потому что без него не резолвится ни один импорт
 * `@elementar/core` (пакет объявляет `"." → "./src/index.ts"`). Когда появится
 * настоящий фасад ядра — с `DocHandle`, `installRuntime` и разбором коллизий имён —
 * этот файл заменяется целиком. Ничего своего он не добавляет: только реэкспорт.
 */

export * from './id.js'
export * from './hlc.js'
export * from './frac.js'

export * from './schema/types.js'
export * from './schema/define.js'
export * from './schema/migrate.js'

export * from './doc/state.js'
export * from './doc/apply.js'
export * from './doc/merge.js'
export * from './doc/purge.js'
export * from './doc/query.js'
export * from './doc/view.js'
export * from './doc/tx.js'
export * from './doc/undo.js'
export * from './doc/handle.js'

export * from './ops/types.js'
export * from './ops/codec.js'
export * from './ops/coalesce.js'
export * from './ops/compact.js'

export * from './proposals/types.js'
export * from './proposals/store.js'

export * from './crypto/index.js'

export * from './storage/schema.js'
export * from './storage/repo.js'
export * from './storage/persist.js'
// OpenOptions уже занят схемой корпуса
export {
  IdbError,
  openDb,
  tryOpenDb,
  runMigrations,
  req,
  txDone,
  withTx,
  getAll,
  getAllFromIndex,
  getOne,
  put,
  del,
  docRange,
} from './storage/idb.js'
export type { IdbErrorReason, OpenResult, OpenOptions as IdbOpenOptions } from './storage/idb.js'

export * from './sync/machine.js'
export * from './sync/chain.js'
export * from './sync/transport.js'
export * from './sync/http.js'
export * from './sync/presence.js'
export * from './sync/digest.js'
export * from './sync/session.js'
// OUTBOX_MAX_TRIES уже экспортирован из storage/schema.js (то же значение)
export {
  WS_LIMITS,
  BEACON_LIMITS,
  b32ByteLength,
  isDead,
  retryDelay,
  packBatch,
  packetBytes,
  framesOf,
  packetOf,
  createOutbox,
} from './sync/outbox.js'
export type { Outbox, OutboxLimits } from './sync/outbox.js'

export * from './util/assert.js'
export * from './util/ct.js'
export * from './util/emitter.js'
export * from './util/batch.js'
export * from './util/backoff.js'
// concatBytes уже экспортирован из crypto/keys.js
export {
  utf8,
  fromUtf8,
  equalBytes,
  toHex,
  base32Encode,
  byteLengthOfUtf8,
} from './util/bytes.js'
