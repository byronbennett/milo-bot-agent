/**
 * Outbox: durable store for outbound events to persist via REST.
 * The orchestrator flushes unsent items periodically.
 */

import type Database from 'better-sqlite3';

export interface OutboxRecord {
  id: number;
  event_type: string;
  payload: string;
  session_id?: string;
  created_at: string;
  sent: number;
  sent_at?: string;
  retries: number;
  last_error?: string;
}

export function enqueueOutbox(
  db: Database.Database,
  eventType: string,
  payload: Record<string, unknown>,
  sessionId?: string
): number {
  const stmt = db.prepare(`
    INSERT INTO outbox (event_type, payload, session_id)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(eventType, JSON.stringify(payload), sessionId ?? null);
  return result.lastInsertRowid as number;
}

export function getUnsent(db: Database.Database, limit = 20): OutboxRecord[] {
  return db.prepare(`
    SELECT * FROM outbox WHERE sent = 0 ORDER BY created_at ASC LIMIT ?
  `).all(limit) as OutboxRecord[];
}

export function markSent(db: Database.Database, id: number): void {
  db.prepare(`
    UPDATE outbox SET sent = 1, sent_at = datetime('now') WHERE id = ?
  `).run(id);
}

export function markFailed(db: Database.Database, id: number, error: string): void {
  db.prepare(`
    UPDATE outbox SET retries = retries + 1, last_error = ? WHERE id = ?
  `).run(error, id);
}
