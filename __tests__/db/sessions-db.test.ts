import Database from 'better-sqlite3';
import {
  upsertSession,
  updateConfirmedProjects,
  getConfirmedProjects,
  getConfirmedProject,
} from '../../app/db/sessions-db.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      session_name TEXT,
      session_type TEXT NOT NULL DEFAULT 'bot',
      status TEXT NOT NULL DEFAULT 'OPEN_IDLE',
      worker_pid INTEGER,
      worker_state TEXT,
      current_task_id TEXT,
      confirmed_project TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      error TEXT
    );
    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('sessions-db multi-project', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    upsertSession(db, {
      sessionId: 'sess-1',
      sessionName: 'test',
      sessionType: 'bot',
      status: 'OPEN_IDLE',
    });
  });

  afterEach(() => db.close());

  it('stores and retrieves multiple projects as JSON array', () => {
    updateConfirmedProjects(db, 'sess-1', ['my-app', 'api-backend']);
    const projects = getConfirmedProjects(db, 'sess-1');
    expect(projects).toEqual(['my-app', 'api-backend']);
  });

  it('returns empty array when no projects are set', () => {
    const projects = getConfirmedProjects(db, 'sess-1');
    expect(projects).toEqual([]);
  });

  it('backward compat: getConfirmedProject returns first project from JSON array', () => {
    updateConfirmedProjects(db, 'sess-1', ['my-app', 'api-backend']);
    const project = getConfirmedProject(db, 'sess-1');
    expect(project).toBe('my-app');
  });

  it('backward compat: getConfirmedProjects handles plain string from old updateConfirmedProject', () => {
    db.prepare('UPDATE sessions SET confirmed_project = ? WHERE session_id = ?').run('legacy-project', 'sess-1');
    const projects = getConfirmedProjects(db, 'sess-1');
    expect(projects).toEqual(['legacy-project']);
  });

  it('getConfirmedProject returns plain string for backward compat', () => {
    db.prepare('UPDATE sessions SET confirmed_project = ? WHERE session_id = ?').run('legacy-project', 'sess-1');
    const project = getConfirmedProject(db, 'sess-1');
    expect(project).toBe('legacy-project');
  });
});
