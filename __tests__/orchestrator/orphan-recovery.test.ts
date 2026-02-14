import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../app/db/schema.js';
import {
  upsertSession,
  updateWorkerState,
  getActiveSessions,
  getSession,
  insertSessionMessage,
  getSessionMessages,
} from '../../app/db/sessions-db.js';

describe('orphan recovery - DB operations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  describe('updateWorkerState', () => {
    test('persists PID and state to sessions table', () => {
      upsertSession(db, {
        sessionId: 'sess-1',
        sessionName: 'test-session',
        sessionType: 'bot',
        status: 'OPEN_IDLE',
      });

      updateWorkerState(db, 'sess-1', 12345, 'ready');

      const session = getSession(db, 'sess-1');
      expect(session).toBeDefined();
      expect(session!.worker_pid).toBe(12345);
      expect(session!.worker_state).toBe('ready');
    });

    test('clears PID when marking dead', () => {
      upsertSession(db, {
        sessionId: 'sess-1',
        sessionName: 'test-session',
        sessionType: 'bot',
        status: 'OPEN_RUNNING',
      });

      updateWorkerState(db, 'sess-1', 12345, 'busy');
      updateWorkerState(db, 'sess-1', null, 'dead');

      const session = getSession(db, 'sess-1');
      expect(session).toBeDefined();
      expect(session!.worker_pid).toBeNull();
      expect(session!.worker_state).toBe('dead');
    });

    test('updates state transitions correctly', () => {
      upsertSession(db, {
        sessionId: 'sess-1',
        sessionName: 'test-session',
        sessionType: 'bot',
        status: 'OPEN_IDLE',
      });

      updateWorkerState(db, 'sess-1', 999, 'starting');
      expect(getSession(db, 'sess-1')!.worker_state).toBe('starting');

      updateWorkerState(db, 'sess-1', 999, 'ready');
      expect(getSession(db, 'sess-1')!.worker_state).toBe('ready');

      updateWorkerState(db, 'sess-1', 999, 'busy');
      expect(getSession(db, 'sess-1')!.worker_state).toBe('busy');

      updateWorkerState(db, 'sess-1', null, 'dead');
      expect(getSession(db, 'sess-1')!.worker_state).toBe('dead');
      expect(getSession(db, 'sess-1')!.worker_pid).toBeNull();
    });
  });

  describe('getActiveSessions', () => {
    test('returns only OPEN sessions', () => {
      upsertSession(db, { sessionId: 'open-1', sessionName: 's1', sessionType: 'bot', status: 'OPEN_IDLE' });
      upsertSession(db, { sessionId: 'open-2', sessionName: 's2', sessionType: 'bot', status: 'OPEN_RUNNING' });
      upsertSession(db, { sessionId: 'closed-1', sessionName: 's3', sessionType: 'bot', status: 'CLOSED' });
      upsertSession(db, { sessionId: 'errored-1', sessionName: 's4', sessionType: 'bot', status: 'ERRORED' });

      const active = getActiveSessions(db);
      expect(active).toHaveLength(2);

      const ids = active.map((s) => s.session_id);
      expect(ids).toContain('open-1');
      expect(ids).toContain('open-2');
      expect(ids).not.toContain('closed-1');
      expect(ids).not.toContain('errored-1');
    });

    test('returns empty array when no active sessions', () => {
      const active = getActiveSessions(db);
      expect(active).toHaveLength(0);
    });
  });

  describe('system audit messages', () => {
    test('stores audit messages with sender=system', () => {
      upsertSession(db, { sessionId: 'sess-1', sessionName: 'test-session', sessionType: 'bot', status: 'OPEN_IDLE' });
      insertSessionMessage(db, 'sess-1', 'system', 'Worker error: something broke');

      const messages = getSessionMessages(db, 'sess-1');
      expect(messages).toHaveLength(1);
      expect(messages[0].sender).toBe('system');
      expect(messages[0].content).toBe('Worker error: something broke');
    });

    test('preserves ordering of system and user messages', () => {
      upsertSession(db, { sessionId: 'sess-1', sessionName: 'test-session', sessionType: 'bot', status: 'OPEN_IDLE' });
      insertSessionMessage(db, 'sess-1', 'user', 'hello');
      insertSessionMessage(db, 'sess-1', 'system', 'Orchestrator shutting down');
      insertSessionMessage(db, 'sess-1', 'agent', 'goodbye');

      const messages = getSessionMessages(db, 'sess-1');
      expect(messages).toHaveLength(3);
      // Returned in DESC order by default
      const senders = messages.map((m) => m.sender);
      expect(senders).toEqual(['agent', 'system', 'user']);
    });
  });
});
