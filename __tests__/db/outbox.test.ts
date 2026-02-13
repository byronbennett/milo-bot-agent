import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../app/db/schema.js';
import { enqueueOutbox, getUnsent, markSent, markFailed } from '../../app/db/outbox.js';

describe('outbox', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  test('enqueue and retrieve unsent items', () => {
    enqueueOutbox(db, 'send_message', { content: 'hello', sessionId: 's1' }, 's1');
    enqueueOutbox(db, 'ack_message', { messageIds: ['m1'] });

    const unsent = getUnsent(db);
    expect(unsent).toHaveLength(2);
    expect(JSON.parse(unsent[0].payload)).toEqual({ content: 'hello', sessionId: 's1' });
  });

  test('markSent removes item from unsent', () => {
    const id = enqueueOutbox(db, 'send_message', { content: 'hi' });
    markSent(db, id);

    const unsent = getUnsent(db);
    expect(unsent).toHaveLength(0);
  });

  test('markFailed increments retries', () => {
    const id = enqueueOutbox(db, 'send_message', { content: 'hi' });
    markFailed(db, id, 'network error');
    markFailed(db, id, 'timeout');

    const unsent = getUnsent(db);
    expect(unsent[0].retries).toBe(2);
    expect(unsent[0].last_error).toBe('timeout');
  });

  test('getUnsent respects limit', () => {
    for (let i = 0; i < 10; i++) {
      enqueueOutbox(db, 'send_message', { content: `msg-${i}` });
    }

    const result = getUnsent(db, 3);
    expect(result).toHaveLength(3);
  });
});
