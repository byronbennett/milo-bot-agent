import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../app/db/schema.js';
import { insertInbox, getUnprocessed, markProcessed } from '../../app/db/inbox.js';

describe('inbox', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  test('insertInbox returns true for new event', () => {
    const result = insertInbox(db, {
      message_id: 'evt-1',
      session_id: 'sess-1',
      session_type: 'bot',
      content: 'hello',
    });
    expect(result).toBe(true);
  });

  test('insertInbox returns false for duplicate message_id', () => {
    insertInbox(db, {
      message_id: 'evt-1',
      session_id: 'sess-1',
      session_type: 'bot',
      content: 'hello',
    });
    const result = insertInbox(db, {
      message_id: 'evt-1',
      session_id: 'sess-1',
      session_type: 'bot',
      content: 'hello again',
    });
    expect(result).toBe(false);
  });

  test('getUnprocessed returns only unprocessed items', () => {
    insertInbox(db, { message_id: 'evt-1', session_id: 's1', session_type: 'bot', content: 'a' });
    insertInbox(db, { message_id: 'evt-2', session_id: 's1', session_type: 'bot', content: 'b' });
    markProcessed(db, 'evt-1');

    const unprocessed = getUnprocessed(db);
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].message_id).toBe('evt-2');
  });

  test('getUnprocessed respects limit', () => {
    for (let i = 0; i < 10; i++) {
      insertInbox(db, { message_id: `evt-${i}`, session_id: 's1', session_type: 'bot', content: `msg-${i}` });
    }

    const result = getUnprocessed(db, 3);
    expect(result).toHaveLength(3);
  });
});
