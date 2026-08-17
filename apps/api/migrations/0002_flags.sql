CREATE TABLE flags (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO flags (k, v, updated_at) VALUES
  ('accept_creates', '1', unixepoch() * 1000),
  ('accept_writes',  '1', unixepoch() * 1000),
  ('llm_relay',      '1', unixepoch() * 1000),
  ('challenge_mode', '0', unixepoch() * 1000);  -- 0 авто, 1 всегда Turnstile, 2 никогда
