/**
 * SQLite database singleton.
 *
 * Opens (or creates) the database file at ~/milo-workspace/.milo/agent.db.
 * Runs schema migrations on first access. All writes go through this module.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { SCHEMA_SQL, MIGRATIONS } from './schema.js';

let db: Database.Database | null = null;

export function getDb(workspaceDir: string): Database.Database {
  if (db) return db;

  const dbDir = join(workspaceDir, '.milo');
  mkdirSync(dbDir, { recursive: true });

  const dbPath = join(dbDir, 'agent.db');
  db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Run schema
  db.exec(SCHEMA_SQL);

  // Run migrations (safe to re-run — each handles "already exists" gracefully)
  runMigrations(db);

  return db;
}

function runMigrations(database: Database.Database): void {
  for (const sql of MIGRATIONS) {
    try {
      database.exec(sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // These errors mean the migration already ran or doesn't apply — safe to ignore:
      // - "duplicate column name": column already exists (ADD COLUMN re-run)
      // - "no such column": old column already renamed (RENAME COLUMN re-run)
      if (msg.includes('duplicate column name') || msg.includes('no such column')) {
        continue;
      }
      throw err;
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export type { Database };
