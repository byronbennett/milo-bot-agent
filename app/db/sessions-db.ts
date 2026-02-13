/**
 * Sessions: SQLite-backed session state (replaces markdown session files).
 */

import type Database from 'better-sqlite3';
import type { SessionStatus, WorkerState } from '../orchestrator/session-types.js';

export interface SessionRecord {
  session_id: string;
  session_name?: string;
  session_type: string;
  status: string;
  worker_pid?: number;
  worker_state?: string;
  current_task_id?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  error?: string;
}

export function upsertSession(db: Database.Database, session: {
  sessionId: string;
  sessionName?: string;
  sessionType: string;
  status: SessionStatus;
}): void {
  db.prepare(`
    INSERT INTO sessions (session_id, session_name, session_type, status)
    VALUES (@sessionId, @sessionName, @sessionType, @status)
    ON CONFLICT(session_id) DO UPDATE SET
      session_name = COALESCE(@sessionName, session_name),
      status = @status,
      updated_at = datetime('now')
  `).run(session);
}

export function updateSessionStatus(db: Database.Database, sessionId: string, status: SessionStatus): void {
  const setClosedAt = status === 'CLOSED' ? ", closed_at = datetime('now')" : '';
  db.prepare(`
    UPDATE sessions SET status = ?, updated_at = datetime('now')${setClosedAt} WHERE session_id = ?
  `).run(status, sessionId);
}

export function updateWorkerState(db: Database.Database, sessionId: string, workerPid: number | null, workerState: WorkerState): void {
  db.prepare(`
    UPDATE sessions SET worker_pid = ?, worker_state = ?, updated_at = datetime('now') WHERE session_id = ?
  `).run(workerPid, workerState, sessionId);
}

export function getSession(db: Database.Database, sessionId: string): SessionRecord | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRecord | undefined;
}

export function getActiveSessions(db: Database.Database): SessionRecord[] {
  return db.prepare(`SELECT * FROM sessions WHERE status LIKE 'OPEN_%' ORDER BY updated_at DESC`).all() as SessionRecord[];
}

export function insertSessionMessage(db: Database.Database, sessionId: string, sender: string, content: string, eventId?: string): void {
  db.prepare(`
    INSERT INTO session_messages (session_id, sender, content, event_id) VALUES (?, ?, ?, ?)
  `).run(sessionId, sender, content, eventId ?? null);
}

export function getSessionMessages(db: Database.Database, sessionId: string, limit = 50): Array<{ sender: string; content: string; created_at: string }> {
  return db.prepare(`
    SELECT sender, content, created_at FROM session_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, limit) as Array<{ sender: string; content: string; created_at: string }>;
}
