/**
 * Inbox: durable store for inbound messages.
 * Deduplicates by event_id. Marks processed after handling.
 */

import type Database from 'better-sqlite3';

export interface InboxRecord {
  event_id: string;
  tenant_id?: string;
  user_id?: string;
  agent_host_id?: string;
  session_id: string;
  session_name?: string;
  session_type: string;
  content: string;
  ui_action?: string;
  received_at: string;
  processed: number;
  processed_at?: string;
}

export function insertInbox(db: Database.Database, record: Omit<InboxRecord, 'received_at' | 'processed' | 'processed_at'>): boolean {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO inbox (event_id, tenant_id, user_id, agent_host_id, session_id, session_name, session_type, content, ui_action)
    VALUES (@event_id, @tenant_id, @user_id, @agent_host_id, @session_id, @session_name, @session_type, @content, @ui_action)
  `);
  const result = stmt.run(record);
  return result.changes > 0; // false = duplicate
}

export function getUnprocessed(db: Database.Database, limit = 50): InboxRecord[] {
  return db.prepare(`
    SELECT * FROM inbox WHERE processed = 0 ORDER BY received_at ASC LIMIT ?
  `).all(limit) as InboxRecord[];
}

export function markProcessed(db: Database.Database, eventId: string): void {
  db.prepare(`
    UPDATE inbox SET processed = 1, processed_at = datetime('now') WHERE event_id = ?
  `).run(eventId);
}
