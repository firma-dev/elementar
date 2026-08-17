/**
 * Единственное место, где живут числа протокола (приложение Б архитектуры).
 * apps/api и клиент не имеют права объявлять эти значения локально.
 */
export const C = {
  // крипта
  DOC_ID_BYTES: 12,
  DOC_ID_CHARS: 20,
  LINK_SECRET_BYTES: 32,
  FRAGMENT_BYTES: 33,
  FRAGMENT_CHARS: 53,
  NONCE_BYTES: 12,
  SESSION_TAG_BYTES: 8,
  GCM_TAG_BYTES: 16,
  HEADER_BYTES: 16,
  AAD_BYTES: 16,
  CHAIN_HASH_BYTES: 32,
  SIG_SKEW_MS: 120_000,
  SIG_NONCE_TTL_MS: 300_000,
  SIG_NONCE_BYTES: 12,
  INVITE_TTL_MS: 900_000,
  INVITE_USES: 1,
  // транспорт
  MAX_DELTA_BYTES: 65_536,
  MAX_PACKET_BYTES: 1_048_576,
  MAX_FRAMES: 256,
  MAX_SNAPSHOT_BYTES: 2_097_152,
  INLINE_SNAPSHOT_BYTES: 262_144,
  WS_FRAME_MAX: 131_072,
  WS_BATCH_OPS: 64,
  KEEPALIVE_BODY_MAX: 61_440,
  // лог
  LOG_SOFT_COUNT: 200,
  LOG_SOFT_BYTES: 524_288,
  LOG_HARD_COUNT: 1_200,
  LOG_HARD_BYTES: 2_621_440,
  LOG_CEIL_COUNT: 2_000,
  LOG_CEIL_BYTES: 4_194_304,
  DOC_TOTAL_BYTES: 12_582_912,
  SNAPSHOT_GENERATIONS: 3,
  TRASH_TTL_DAYS: 7,
  ACK_WINDOW_DAYS: 30,
  // жизненный цикл
  TTL_ACTIVE_DAYS: 365,
  TTL_EMPTY_DAYS: 7,
  TOMBSTONE_DAYS: 7,
  SOFT_DELETE_DAYS: 30,
  COLD_AFTER_DAYS: 90,
  // клиент
  SNAPSHOT_AFTER_OPS: 400,
  SNAPSHOT_AFTER_BYTES: 262_144,
  SNAPSHOT_DEBOUNCE_MS: 2_000,
  TEXT_DEBOUNCE_MS: 1_500,
  COALESCE_WINDOW_MS: 30_000,
  HEARTBEAT_MS: 25_000,
  HEARTBEAT_TIMEOUT_MS: 10_000,
  PRESENCE_TTL_MS: 30_000,
  PRESENCE_BEAT_MS: 15_000,
  BACKOFF_MAX_MS: 60_000,
  BACKOFF_JITTER: 0.3,
  HIDDEN_DISCONNECT_MS: 60_000,
  DIGEST_THRESHOLD: 5,
  UNDO_STACK: 50,
  CONFLICT_RING: 3,
  MAX_PEERS: 8,
  CLIENT_LRU: 16,
  // лимиты
  AUTH_BUCKET_CAPACITY: 240,
  AUTH_BUCKET_REFILL: 4,
  MISS_BUCKET_CAPACITY: 20,
  MISS_BUCKET_REFILL: 0.2,
  MISS_BASE: 5,
  MISS_COST_CAP_EXP: 4,
  MISS_STREAK_BLOCK: 20,
  BLOCK_MAX_MS: 900_000,
  CHALLENGE_MS: 600_000,
  LIMITER_SHARDS: 256,
  EXISTS_CACHE_POS_S: 300,
  EXISTS_CACHE_NEG_S: 60,
  MIN_404_MS: 25,
  // пароль
  ARGON2_M_KIB: 65_536,
  ARGON2_T: 3,
  ARGON2_P: 1,
  PBKDF2_ITERATIONS: 600_000,
  KDF_SALT_BYTES: 16,
  KDF_TARGET_MS: 700,
  PASSPHRASE_WORDS: 5,
  PASSPHRASE_BITS: 55,
  PASSWORD_MIN_BITS: 40,
} as const

/** Два раздельных бакета лимитера (§9.2). */
export const BUCKETS = {
  auth: { capacity: C.AUTH_BUCKET_CAPACITY, refillPerSec: C.AUTH_BUCKET_REFILL },
  miss: { capacity: C.MISS_BUCKET_CAPACITY, refillPerSec: C.MISS_BUCKET_REFILL },
} as const

/**
 * Жёсткие клампы параметров KDF из wrap-записи (§5.5).
 * Значение за границей — ошибка, а не исполнение.
 */
export const KDF_LIMITS = {
  argon2id: { mMax: 262_144, mMin: 8_192, tMax: 8, tMin: 1, pMax: 4, pMin: 1 },
  pbkdf2: { iMax: 5_000_000, iMin: 100_000 },
  algAllow: ['none', 'argon2id', 'pbkdf2-sha256'] as const,
} as const

/** Цены операций в auth-бакете (§9.2). Операции с ценой от размера — функции ниже. */
export const OP_COST = {
  health: 0,
  challenge: 1,
  getDoc: 1,
  getDeltas: 2,
  getSnapshot: 3,
  putWrap: 5,
  deleteDoc: 5,
  undelete: 5,
  createInvite: 5,
  getInvite: 5,
  wsUpgrade: 5,
  createDoc: 25,
  llm: 50,
} as const

/** `POST /deltas`: 4 + ⌈bytes / 16 KiB⌉. */
export function pushDeltasCost(bytes: number): number {
  return 4 + Math.ceil(Math.max(0, bytes) / 16_384)
}

/** `PUT /snapshot`: 10 + ⌈bytes / 32 KiB⌉. */
export function putSnapshotCost(bytes: number): number {
  return 10 + Math.ceil(Math.max(0, bytes) / 32_768)
}

/** Цена промаха: 5, 10, 20, 40, 80 — потолок 80 (§9.2). */
export function missCost(streak: number): number {
  const s = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0
  return C.MISS_BASE * 2 ** Math.min(s, C.MISS_COST_CAP_EXP)
}

/** Экспоненциальный бэкофф переподключения, ±BACKOFF_JITTER (§8.7). */
export const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const

const DAY_MS = 86_400_000

/** Пороги TTL и окон в миллисекундах — чтобы дни не пересчитывались на каждой стороне. */
export const MS = {
  TRASH_TTL: C.TRASH_TTL_DAYS * DAY_MS,
  ACK_WINDOW: C.ACK_WINDOW_DAYS * DAY_MS,
  TTL_ACTIVE: C.TTL_ACTIVE_DAYS * DAY_MS,
  TTL_EMPTY: C.TTL_EMPTY_DAYS * DAY_MS,
  TOMBSTONE: C.TOMBSTONE_DAYS * DAY_MS,
  SOFT_DELETE: C.SOFT_DELETE_DAYS * DAY_MS,
  COLD_AFTER: C.COLD_AFTER_DAYS * DAY_MS,
} as const
