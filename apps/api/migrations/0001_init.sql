-- Каталог документов. Ни одного байта пользовательских данных.
CREATE TABLE docs (
  id              TEXT    PRIMARY KEY,         -- docId, 20 симв. Crockford base32
  sig_alg         INTEGER NOT NULL,            -- 1 = ed25519, 2 = ecdsa-p256
  sig_pub         BLOB    NOT NULL,            -- 32 (ed25519) или 65 (p256) байт
  app             INTEGER NOT NULL DEFAULT 0,  -- 0 unknown, 1 planer, 2 finanser, …
  state           INTEGER NOT NULL DEFAULT 0,  -- 0 active, 1 tombstone, 2 frozen

  seq             INTEGER NOT NULL DEFAULT 0,
  snapshot_seq    INTEGER NOT NULL DEFAULT 0,
  snapshot_gen    INTEGER NOT NULL DEFAULT 0,
  snapshot_bytes  INTEGER NOT NULL DEFAULT 0,
  snapshot_loc    INTEGER NOT NULL DEFAULT 0,  -- 0 = внутри DO, 1 = R2
  log_count       INTEGER NOT NULL DEFAULT 0,
  log_bytes       INTEGER NOT NULL DEFAULT 0,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  wrap_ver        INTEGER NOT NULL DEFAULT 1,  -- монотонный, §5.5

  created_at      INTEGER NOT NULL,            -- unix ms
  updated_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,            -- дебаунс 1 ч
  expires_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                     -- тумбстон; восстановление до deleted_at + 7d
  purge_after     INTEGER                      -- физическое стирание не раньше этого момента
) STRICT;

CREATE INDEX idx_docs_gc        ON docs (state, expires_at);
CREATE INDEX idx_docs_purge     ON docs (state, purge_after);
CREATE INDEX idx_docs_last_seen ON docs (last_seen_at);
CREATE INDEX idx_docs_big       ON docs (total_bytes DESC) WHERE state = 0;

-- Очередь физической уборки.
CREATE TABLE gc_queue (
  id        TEXT    PRIMARY KEY,     -- '<docId>' или '<docId>#snap<gen>' или '<docId>#trash'
  stage     INTEGER NOT NULL DEFAULT 0,  -- 0 новый, 1 r2 очищен, 2 do очищен
  attempts  INTEGER NOT NULL DEFAULT 0,
  due_at    INTEGER NOT NULL,
  last_err  TEXT
) STRICT;

CREATE INDEX idx_gc_due ON gc_queue (due_at, stage);

-- Зеркало блокировок из LimiterDO: только для админского обзора. TTL обязателен.
CREATE TABLE abuse_blocks (
  prefix_hash   BLOB    PRIMARY KEY,   -- HMAC(pepper_дня, ip-префикс)[0..16]
  reason        INTEGER NOT NULL,      -- 1 miss-storm, 2 create-flood, 3 bytes-flood, 4 llm-flood, 9 ручной
  strikes       INTEGER NOT NULL DEFAULT 1,
  blocked_until INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,      -- физическое удаление строки, ≤ 48 ч
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_blocks_expires ON abuse_blocks (expires_at);

-- Только агрегаты. Ни одного docId.
CREATE TABLE metrics_daily (
  day            TEXT    PRIMARY KEY,  -- 'YYYY-MM-DD' UTC
  docs_created   INTEGER NOT NULL DEFAULT 0,
  docs_deleted   INTEGER NOT NULL DEFAULT 0,
  docs_expired   INTEGER NOT NULL DEFAULT 0,
  deltas_in      INTEGER NOT NULL DEFAULT 0,
  bytes_in       INTEGER NOT NULL DEFAULT 0,
  bytes_out      INTEGER NOT NULL DEFAULT 0,
  ws_opens       INTEGER NOT NULL DEFAULT 0,
  compactions    INTEGER NOT NULL DEFAULT 0,
  blocks_issued  INTEGER NOT NULL DEFAULT 0,
  challenges     INTEGER NOT NULL DEFAULT 0,
  http_429       INTEGER NOT NULL DEFAULT 0,
  http_404       INTEGER NOT NULL DEFAULT 0
) STRICT;
