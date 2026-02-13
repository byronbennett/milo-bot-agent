/**
 * SQLite schema for the orchestrator's durable inbox/outbox and session state.
 *
 * Tables:
 * - inbox: inbound messages from PubNub/REST, deduped by event_id
 * - outbox: outbound events to persist via REST (retry queue)
 * - sessions: active session state (replaces markdown files)
 * - session_messages: per-session message log for context
 */

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inbox (
    event_id    TEXT PRIMARY KEY,
    tenant_id   TEXT,
    user_id     TEXT,
    agent_host_id TEXT,
    session_id  TEXT NOT NULL,
    session_name TEXT,
    session_type TEXT NOT NULL DEFAULT 'bot',
    content     TEXT NOT NULL,
    ui_action   TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed   INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
    ON inbox (processed, received_at)
    WHERE processed = 0;

  CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    session_id  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sent        INTEGER NOT NULL DEFAULT 0,
    sent_at     TEXT,
    retries     INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_unsent
    ON outbox (sent, created_at)
    WHERE sent = 0;

  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    session_name  TEXT,
    session_type  TEXT NOT NULL DEFAULT 'bot',
    status        TEXT NOT NULL DEFAULT 'OPEN_IDLE',
    worker_pid    INTEGER,
    worker_state  TEXT DEFAULT 'dead',
    current_task_id TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at     TEXT,
    error         TEXT
  );

  CREATE TABLE IF NOT EXISTS session_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    sender      TEXT NOT NULL,
    content     TEXT NOT NULL,
    event_id    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_session_messages_session
    ON session_messages (session_id, created_at);
`;
