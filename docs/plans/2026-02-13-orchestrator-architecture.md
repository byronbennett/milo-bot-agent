# Orchestrator Architecture Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current single-threaded agent (`agent.ts`) with a durable orchestrator + child-process worker architecture that handles concurrent sessions, provides deterministic message ordering, safe cancellation, and crash recovery via SQLite.

**Architecture:** A single Node orchestrator process owns all PubNub subscriptions, SQLite writes, and session routing. Each active session gets a long-lived child-process worker that communicates with the orchestrator over JSON Lines IPC. Workers never touch PubNub or SQLite directly.

**Tech Stack:** Node.js 20+, TypeScript (ESM), `better-sqlite3` (sync SQLite), `pubnub` (existing), `claude-code-js` (existing), `zod` (existing)

---

## Current State Summary

The existing architecture lives primarily in `app/agent.ts` (~700 lines). It's a monolithic `MiloAgent` class that:
- Owns PubNub + REST adapters, session manager, heartbeat scheduler
- Processes messages **serially within a single async flow** but PubNub `onMessage` fires concurrently (fire-and-forget)
- Has **no message queue, no dedup, no durable inbox**
- Manages Claude Code sessions in-process via `claude-code/bridge.ts` (a `Map<string, SessionState>`)
- Persists session state as **markdown files** via `session/manager.ts`
- Has no cancel semantics (no `SIGINT` forwarding, no task preemption)
- Has race conditions on concurrent session creation (session limit check is not atomic)

### Files That Will Be Replaced or Heavily Modified

| File | Disposition |
|------|------------|
| `app/agent.ts` | **Replace** with new orchestrator |
| `app/session/manager.ts` | **Replace** — SQLite replaces markdown files |
| `app/task/orchestrator.ts` | **Replace** — workers own task execution |
| `app/task/executor.ts` | **Move** into worker process |
| `app/claude-code/bridge.ts` | **Move** into worker process |
| `app/messaging/pubnub-adapter.ts` | **Modify** — orchestrator-only, add new event types |
| `app/messaging/pubnub-types.ts` | **Modify** — expand event schema |
| `app/scheduler/heartbeat.ts` | **Keep** — minor changes |
| `app/commands/start.ts` | **Modify** — instantiate orchestrator instead of MiloAgent |

### Files That Stay Unchanged

| File | Reason |
|------|--------|
| `app/intent/*` | Intent parsing is stateless, reused as-is |
| `app/prompt/*` | Prompt enhancement is stateless, reused as-is |
| `app/auto-answer/*` | Auto-answer is stateless, reused as-is |
| `app/tools/*` | Tool registry is stateless, reused as-is |
| `app/config/*` | Config loading unchanged |
| `app/utils/*` | Logger, AI client, keychain unchanged |
| `app/shared/*` | Types extended but not broken |

---

## Dependency: `better-sqlite3`

We need one new dependency. `better-sqlite3` is synchronous, single-writer, zero-config, and perfect for an operational inbox/outbox pattern.

---

## Task Breakdown

### Task 1: Add `better-sqlite3` dependency and create SQLite schema module

**Files:**
- Create: `app/db/schema.ts`
- Create: `app/db/index.ts`

**Step 1: Install better-sqlite3**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3`
Expected: Package added to package.json

**Step 2: Create the schema module**

Create `app/db/schema.ts`:

```typescript
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
```

**Step 3: Create the DB singleton module**

Create `app/db/index.ts`:

```typescript
/**
 * SQLite database singleton.
 *
 * Opens (or creates) the database file at ~/milo-workspace/.milo/agent.db.
 * Runs schema migrations on first access. All writes go through this module.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { SCHEMA_SQL } from './schema.js';

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

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export type { Database };
```

**Step 4: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 5: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/db/schema.ts app/db/index.ts package.json pnpm-lock.yaml
git commit -m "feat: add SQLite schema and DB module for orchestrator inbox/outbox"
```

---

### Task 2: Define IPC protocol types and session actor types

**Files:**
- Create: `app/orchestrator/ipc-types.ts`
- Create: `app/orchestrator/session-types.ts`

**Step 1: Create IPC message types**

Create `app/orchestrator/ipc-types.ts`:

```typescript
/**
 * IPC protocol between orchestrator and worker processes.
 * Communication is JSON Lines over stdin/stdout.
 */

// --- Orchestrator → Worker ---

export interface WorkerInitMessage {
  type: 'WORKER_INIT';
  sessionId: string;
  sessionName: string;
  sessionType: 'chat' | 'bot';
  projectPath: string;
  workspaceDir: string;
  config: {
    aiModel: string;
    anthropicApiKey?: string;
  };
}

export interface WorkerTaskMessage {
  type: 'WORKER_TASK';
  taskId: string;
  userEventId: string;
  prompt: string;
  context?: {
    chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    sessionName?: string;
    projectName?: string;
  };
}

export interface WorkerCancelMessage {
  type: 'WORKER_CANCEL';
  taskId: string;
  reason?: string;
}

export interface WorkerCloseMessage {
  type: 'WORKER_CLOSE';
  reason?: string;
}

export type OrchestratorToWorker =
  | WorkerInitMessage
  | WorkerTaskMessage
  | WorkerCancelMessage
  | WorkerCloseMessage;

// --- Worker → Orchestrator ---

export interface WorkerReadyMessage {
  type: 'WORKER_READY';
  sessionId: string;
  pid: number;
}

export interface WorkerTaskStartedMessage {
  type: 'WORKER_TASK_STARTED';
  taskId: string;
  sessionId: string;
}

export interface WorkerTaskDoneMessage {
  type: 'WORKER_TASK_DONE';
  taskId: string;
  sessionId: string;
  success: boolean;
  output?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
}

export interface WorkerTaskCancelledMessage {
  type: 'WORKER_TASK_CANCELLED';
  taskId: string;
  sessionId: string;
}

export interface WorkerErrorMessage {
  type: 'WORKER_ERROR';
  sessionId: string;
  error: string;
  fatal: boolean;
}

export interface WorkerProgressMessage {
  type: 'WORKER_PROGRESS';
  taskId: string;
  sessionId: string;
  message: string;
}

export type WorkerToOrchestrator =
  | WorkerReadyMessage
  | WorkerTaskStartedMessage
  | WorkerTaskDoneMessage
  | WorkerTaskCancelledMessage
  | WorkerErrorMessage
  | WorkerProgressMessage;

// Union of all IPC messages
export type IPCMessage = OrchestratorToWorker | WorkerToOrchestrator;
```

**Step 2: Create session actor types**

Create `app/orchestrator/session-types.ts`:

```typescript
/**
 * Session actor state types.
 * Each active session is represented by a SessionActor managed by the orchestrator.
 */

export type SessionStatus =
  | 'OPEN_IDLE'
  | 'OPEN_RUNNING'
  | 'OPEN_WAITING_USER'
  | 'OPEN_PAUSED'
  | 'CLOSED'
  | 'ERRORED';

export type WorkerState = 'starting' | 'ready' | 'busy' | 'dead';

export type WorkItemType =
  | 'USER_MESSAGE'
  | 'CANCEL'
  | 'CLOSE_SESSION'
  | 'STATUS_REQUEST';

export interface WorkItem {
  id: string;
  type: WorkItemType;
  eventId: string;
  sessionId: string;
  content: string;
  priority: 'high' | 'normal';
  createdAt: Date;
}

export interface WorkerHandle {
  pid: number;
  state: WorkerState;
  sessionId: string;
  process: import('child_process').ChildProcess;
}

export interface CurrentTask {
  taskId: string;
  userEventId: string;
  startedAt: Date;
  cancelRequested: boolean;
  cancelRequestedAt?: Date;
}

export interface SessionActor {
  sessionId: string;
  sessionName: string;
  sessionType: 'chat' | 'bot';
  status: SessionStatus;
  worker: WorkerHandle | null;
  currentTask: CurrentTask | null;
  queueHigh: WorkItem[];
  queueNormal: WorkItem[];
  projectPath: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**Step 3: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/ipc-types.ts app/orchestrator/session-types.ts
git commit -m "feat: define IPC protocol and session actor types"
```

---

### Task 3: Expand PubNub event types for orchestrator events

**Files:**
- Modify: `app/messaging/pubnub-types.ts`

**Step 1: Update PubNub event types**

The current `PubNubEventMessage` has `type: 'agent_message' | 'session_update' | 'agent_status'`. Expand it to cover the full orchestrator event vocabulary.

In `app/messaging/pubnub-types.ts`, replace the `PubNubEventMessage` interface:

```typescript
/**
 * Orchestrator → Browser (evt channel)
 *
 * Discriminated union by `type`. The browser uses `type` to route
 * each event to the correct UI handler.
 */
export type PubNubEventType =
  | 'agent_message'
  | 'session_update'
  | 'agent_status'
  | 'message_received'
  | 'session_status_changed'
  | 'subagent_started'
  | 'subagent_stopped'
  | 'subagent_output'
  | 'task_cancel_requested'
  | 'task_cancelled'
  | 'error';

export interface PubNubEventMessage {
  type: PubNubEventType;
  messageId?: string;
  agentId: string;
  sessionId?: string;
  content?: string;
  sessionStatus?: string;
  sessionName?: string;
  contextSize?: { usedTokens: number; maxTokens: number };
  /** The event_id this receipt acknowledges (for message_received) */
  receivedEventId?: string;
  /** Whether the message was queued for processing */
  queued?: boolean;
  /** Error details for error events */
  errorMessage?: string;
  /** Worker PID for subagent lifecycle events */
  workerPid?: number;
  timestamp: string;
}
```

**Step 2: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors (existing code uses string literals that are a subset of the new union)

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/messaging/pubnub-types.ts
git commit -m "feat: expand PubNub event types for orchestrator events"
```

---

### Task 4: Build the inbox/outbox data access layer

**Files:**
- Create: `app/db/inbox.ts`
- Create: `app/db/outbox.ts`
- Create: `app/db/sessions-db.ts`

**Step 1: Create inbox data access**

Create `app/db/inbox.ts`:

```typescript
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
```

**Step 2: Create outbox data access**

Create `app/db/outbox.ts`:

```typescript
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
```

**Step 3: Create sessions DB access**

Create `app/db/sessions-db.ts`:

```typescript
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
  const closedAt = status === 'CLOSED' ? "datetime('now')" : 'NULL';
  db.prepare(`
    UPDATE sessions SET status = ?, updated_at = datetime('now'), closed_at = ${closedAt === 'NULL' ? 'NULL' : "datetime('now')"} WHERE session_id = ?
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
```

**Step 4: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 5: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/db/inbox.ts app/db/outbox.ts app/db/sessions-db.ts
git commit -m "feat: add inbox, outbox, and sessions data access layer"
```

---

### Task 5: Build the worker process entry point

The worker is a standalone Node process that:
- Receives `WORKER_INIT` on stdin, sends `WORKER_READY` on stdout
- Receives `WORKER_TASK`, runs Claude Code or AI chat, sends `WORKER_TASK_DONE`
- Receives `WORKER_CANCEL`, aborts current task, sends `WORKER_TASK_CANCELLED`
- Receives `WORKER_CLOSE`, cleans up and exits

**Files:**
- Create: `app/orchestrator/ipc.ts` (shared JSON Lines read/write helpers)
- Create: `app/orchestrator/worker.ts` (worker entry point)

**Step 1: Create shared IPC helpers**

Create `app/orchestrator/ipc.ts`:

```typescript
/**
 * JSON Lines IPC helpers for orchestrator ↔ worker communication.
 *
 * Protocol: one JSON object per line, delimited by \n.
 * Used over stdin/stdout of child processes.
 */

import type { Readable, Writable } from 'stream';
import type { IPCMessage } from './ipc-types.js';

/**
 * Write a single IPC message to a writable stream.
 */
export function sendIPC(stream: Writable, message: IPCMessage): void {
  stream.write(JSON.stringify(message) + '\n');
}

/**
 * Create an async iterator that yields parsed IPC messages from a readable stream.
 */
export async function* readIPC(stream: Readable): AsyncGenerator<IPCMessage> {
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString();

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        yield JSON.parse(line) as IPCMessage;
      } catch {
        // Skip malformed lines — log to stderr so it doesn't pollute IPC stdout
        process.stderr.write(`[ipc] malformed JSON line: ${line.slice(0, 200)}\n`);
      }
    }
  }
}
```

**Step 2: Create the worker entry point**

Create `app/orchestrator/worker.ts`:

```typescript
/**
 * Worker process entry point.
 *
 * Spawned by the orchestrator as a child process.
 * Communicates via JSON Lines on stdin (receive) / stdout (send).
 * Stderr is reserved for logging (piped to orchestrator's logger).
 *
 * Lifecycle:
 *   1. Receive WORKER_INIT → initialize session context → send WORKER_READY
 *   2. Receive WORKER_TASK → execute → send WORKER_TASK_DONE
 *   3. Receive WORKER_CANCEL → abort current task → send WORKER_TASK_CANCELLED
 *   4. Receive WORKER_CLOSE → cleanup → exit(0)
 *
 * Usage: node --import tsx/esm app/orchestrator/worker.ts
 */

import { sendIPC, readIPC } from './ipc.js';
import type {
  WorkerInitMessage,
  WorkerTaskMessage,
  WorkerCancelMessage,
  WorkerToOrchestrator,
} from './ipc-types.js';

// Worker state
let sessionId = '';
let sessionName = '';
let sessionType: 'chat' | 'bot' = 'bot';
let projectPath = '';
let workspaceDir = '';
let initialized = false;
let currentTaskId: string | null = null;
let cancelRequested = false;

// Claude Code session (lazy, kept alive across tasks)
let claudeSession: unknown = null;

function send(msg: WorkerToOrchestrator): void {
  sendIPC(process.stdout, msg);
}

function log(message: string): void {
  process.stderr.write(`[worker:${sessionId || 'init'}] ${message}\n`);
}

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  sessionId = msg.sessionId;
  sessionName = msg.sessionName;
  sessionType = msg.sessionType;
  projectPath = msg.projectPath;
  workspaceDir = msg.workspaceDir;

  // Set API keys if provided
  if (msg.config.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = msg.config.anthropicApiKey;
  }

  initialized = true;
  log(`Initialized (type=${sessionType}, project=${projectPath})`);

  send({ type: 'WORKER_READY', sessionId, pid: process.pid });
}

async function handleTask(msg: WorkerTaskMessage): Promise<void> {
  if (!initialized) {
    send({ type: 'WORKER_ERROR', sessionId, error: 'Worker not initialized', fatal: true });
    return;
  }

  currentTaskId = msg.taskId;
  cancelRequested = false;

  send({ type: 'WORKER_TASK_STARTED', taskId: msg.taskId, sessionId });
  log(`Task started: ${msg.taskId}`);

  try {
    let output: string;

    if (sessionType === 'chat') {
      output = await executeChatTask(msg);
    } else {
      output = await executeClaudeCodeTask(msg);
    }

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
    } else {
      send({
        type: 'WORKER_TASK_DONE',
        taskId: msg.taskId,
        sessionId,
        success: true,
        output,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Task failed: ${error}`);

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
    } else {
      send({
        type: 'WORKER_TASK_DONE',
        taskId: msg.taskId,
        sessionId,
        success: false,
        error,
      });
    }
  } finally {
    currentTaskId = null;
    cancelRequested = false;
    // Signal readiness for next task
    send({ type: 'WORKER_READY', sessionId, pid: process.pid });
  }
}

async function handleCancel(msg: WorkerCancelMessage): Promise<void> {
  log(`Cancel requested for task: ${msg.taskId}`);
  cancelRequested = true;

  // If we have a Claude Code session, abort it
  if (claudeSession && typeof (claudeSession as { abort?: () => void }).abort === 'function') {
    (claudeSession as { abort: () => void }).abort();
  }

  // The running task's try/catch will pick up cancelRequested and send WORKER_TASK_CANCELLED
}

async function executeChatTask(msg: WorkerTaskMessage): Promise<string> {
  // Dynamic import to avoid loading Anthropic SDK until needed
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const ai = new Anthropic();

  const messages = msg.context?.chatHistory ?? [];
  messages.push({ role: 'user', content: msg.prompt });

  const response = await ai.messages.create({
    model: process.env.AI_MODEL || 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    system: 'You are MiloBot, a helpful coding assistant. Be concise and helpful.',
    messages,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : 'No response generated.';
}

async function executeClaudeCodeTask(msg: WorkerTaskMessage): Promise<string> {
  // Dynamic import to avoid loading SDK until needed
  const { ClaudeCode } = await import('claude-code-js');

  // Reuse or create Claude Code instance
  if (!claudeSession) {
    const claude = new ClaudeCode({ workingDirectory: projectPath });
    claudeSession = claude.newSession();
  }

  const session = claudeSession as { prompt: (opts: { prompt: string }) => Promise<{ result?: string; cost_usd?: number; duration_ms?: number }> };

  const response = await session.prompt({ prompt: msg.prompt });
  return response.result ?? 'No output from Claude Code.';
}

// --- Main loop ---

async function main(): Promise<void> {
  log('Worker process starting...');

  for await (const msg of readIPC(process.stdin)) {
    switch (msg.type) {
      case 'WORKER_INIT':
        await handleInit(msg);
        break;
      case 'WORKER_TASK':
        await handleTask(msg);
        break;
      case 'WORKER_CANCEL':
        await handleCancel(msg);
        break;
      case 'WORKER_CLOSE':
        log('Close requested, exiting...');
        process.exit(0);
        break;
      default:
        log(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  // stdin closed — orchestrator died or closed pipe
  log('stdin closed, exiting...');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[worker] Fatal error: ${err}\n`);
  process.exit(1);
});
```

**Step 3: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/ipc.ts app/orchestrator/worker.ts
git commit -m "feat: add IPC helpers and worker process entry point"
```

---

### Task 6: Build the session actor manager

This module manages the `Map<string, SessionActor>` — spawning workers, routing messages to queues, dispatching tasks, and handling cancel/close.

**Files:**
- Create: `app/orchestrator/session-actor.ts`

**Step 1: Create session actor manager**

Create `app/orchestrator/session-actor.ts`:

```typescript
/**
 * Session Actor Manager
 *
 * Manages the lifecycle of session actors and their worker processes.
 * Each session gets a dedicated long-lived worker child process.
 *
 * Responsibilities:
 * - Spawn/respawn worker processes
 * - Route work items to session queues (high priority for control, normal for messages)
 * - Dispatch next queued task when worker becomes ready
 * - Handle cancel escalation (SIGINT → SIGTERM → SIGKILL)
 * - Unload inactive sessions
 */

import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import { sendIPC, readIPC } from './ipc.js';
import type {
  OrchestratorToWorker,
  WorkerToOrchestrator,
} from './ipc-types.js';
import type {
  SessionActor,
  WorkItem,
  WorkerState,
  SessionStatus,
} from './session-types.js';
import { Logger } from '../utils/logger.js';

export interface SessionActorManagerOptions {
  workspaceDir: string;
  workerScript: string;
  anthropicApiKey?: string;
  aiModel?: string;
  logger: Logger;
  onWorkerEvent: (sessionId: string, event: WorkerToOrchestrator) => void;
}

export class SessionActorManager {
  private actors = new Map<string, SessionActor>();
  private options: SessionActorManagerOptions;
  private logger: Logger;

  constructor(options: SessionActorManagerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /**
   * Get or create a session actor. Spawns a worker if none is alive.
   */
  async getOrCreate(sessionId: string, meta: {
    sessionName: string;
    sessionType: 'chat' | 'bot';
    projectPath: string;
  }): Promise<SessionActor> {
    let actor = this.actors.get(sessionId);

    if (!actor) {
      actor = {
        sessionId,
        sessionName: meta.sessionName,
        sessionType: meta.sessionType,
        status: 'OPEN_IDLE',
        worker: null,
        currentTask: null,
        queueHigh: [],
        queueNormal: [],
        projectPath: meta.projectPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.actors.set(sessionId, actor);
    }

    // Ensure worker is alive
    if (!actor.worker || actor.worker.state === 'dead') {
      await this.spawnWorker(actor);
    }

    return actor;
  }

  /**
   * Enqueue a work item for a session.
   */
  enqueue(sessionId: string, item: WorkItem): void {
    const actor = this.actors.get(sessionId);
    if (!actor) {
      this.logger.warn(`No actor for session ${sessionId}, dropping work item`);
      return;
    }

    if (item.priority === 'high') {
      actor.queueHigh.push(item);
    } else {
      actor.queueNormal.push(item);
    }

    actor.updatedAt = new Date();
    this.tryDispatch(actor);
  }

  /**
   * Get a session actor by ID (or undefined).
   */
  get(sessionId: string): SessionActor | undefined {
    return this.actors.get(sessionId);
  }

  /**
   * List all active session actors.
   */
  listActive(): SessionActor[] {
    return Array.from(this.actors.values()).filter(
      (a) => a.status.startsWith('OPEN_')
    );
  }

  /**
   * Close a session: cancel running tasks, terminate worker, mark closed.
   */
  async closeSession(sessionId: string): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) return;

    // Cancel any running task first
    if (actor.currentTask && actor.worker) {
      await this.cancelCurrentTask(actor);
    }

    // Send WORKER_CLOSE
    if (actor.worker && actor.worker.state !== 'dead') {
      this.sendToWorker(actor, { type: 'WORKER_CLOSE', reason: 'session closed' });
      // Give it 3s to exit gracefully
      await this.waitForExit(actor.worker.process, 3000);
    }

    actor.status = 'CLOSED';
    actor.updatedAt = new Date();

    // Keep actor in map briefly for any final events, then unload
    setTimeout(() => {
      const a = this.actors.get(sessionId);
      if (a && a.status === 'CLOSED') {
        this.actors.delete(sessionId);
      }
    }, 10_000);
  }

  /**
   * Cancel the current task in a session (does not close the session).
   */
  async cancelCurrentTask(actor: SessionActor): Promise<void> {
    if (!actor.currentTask || !actor.worker) return;

    actor.currentTask.cancelRequested = true;
    actor.currentTask.cancelRequestedAt = new Date();

    // Step 1: soft cancel via IPC
    this.sendToWorker(actor, {
      type: 'WORKER_CANCEL',
      taskId: actor.currentTask.taskId,
    });

    // Step 2: SIGINT for PTY-based tools
    if (actor.worker.process.pid) {
      try {
        process.kill(actor.worker.process.pid, 'SIGINT');
      } catch { /* process may have already exited */ }
    }

    // Step 3: escalation timer
    const pid = actor.worker.process.pid;
    setTimeout(() => {
      // If task is still running after 4s, SIGTERM
      if (actor.currentTask?.cancelRequested && actor.worker?.state === 'busy') {
        this.logger.warn(`Cancel escalation: SIGTERM to worker ${pid}`);
        try { if (pid) process.kill(pid, 'SIGTERM'); } catch { /* */ }

        // Final escalation: SIGKILL after 3 more seconds
        setTimeout(() => {
          if (actor.worker?.state === 'busy') {
            this.logger.warn(`Cancel escalation: SIGKILL to worker ${pid}`);
            try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* */ }
            this.markWorkerDead(actor);
          }
        }, 3000);
      }
    }, 4000);
  }

  /**
   * Shutdown all sessions (for agent stop).
   */
  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.actors.keys()).map((id) =>
      this.closeSession(id)
    );
    await Promise.allSettled(promises);
    this.actors.clear();
  }

  // --- Private helpers ---

  private async spawnWorker(actor: SessionActor): Promise<void> {
    this.logger.info(`Spawning worker for session ${actor.sessionId}`);

    const child = fork(this.options.workerScript, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_OPTIONS: '--import tsx/esm',
      },
      silent: true, // pipe stdin/stdout/stderr
    });

    const workerPid = child.pid!;

    actor.worker = {
      pid: workerPid,
      state: 'starting',
      sessionId: actor.sessionId,
      process: child,
    };

    // Pipe stderr to our logger
    child.stderr?.on('data', (data: Buffer) => {
      this.logger.debug(`[worker:${actor.sessionId}] ${data.toString().trim()}`);
    });

    // Listen for IPC messages from worker stdout
    this.listenToWorker(actor, child);

    // Handle unexpected exit
    child.on('exit', (code, signal) => {
      this.logger.warn(`Worker ${workerPid} exited (code=${code}, signal=${signal})`);
      this.markWorkerDead(actor);
    });

    // Send WORKER_INIT
    sendIPC(child.stdin!, {
      type: 'WORKER_INIT',
      sessionId: actor.sessionId,
      sessionName: actor.sessionName,
      sessionType: actor.sessionType,
      projectPath: actor.projectPath,
      workspaceDir: this.options.workspaceDir,
      config: {
        aiModel: this.options.aiModel ?? 'claude-sonnet-4-5-20250929',
        anthropicApiKey: this.options.anthropicApiKey,
      },
    });

    // Wait for WORKER_READY (with timeout)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 15_000);

      const checkReady = () => {
        if (actor.worker?.state === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (actor.worker?.state === 'dead') {
          clearTimeout(timeout);
          reject(new Error('Worker died during init'));
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  }

  private listenToWorker(actor: SessionActor, child: ChildProcess): void {
    if (!child.stdout) return;

    // Use a simple line-based parser (can't use async generator in event handler easily)
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as WorkerToOrchestrator;
          this.handleWorkerMessage(actor, msg);
        } catch {
          this.logger.debug(`[worker:${actor.sessionId}] non-JSON stdout: ${line.slice(0, 200)}`);
        }
      }
    });
  }

  private handleWorkerMessage(actor: SessionActor, msg: WorkerToOrchestrator): void {
    this.logger.verbose(`[worker:${actor.sessionId}] ${msg.type}`);

    switch (msg.type) {
      case 'WORKER_READY':
        if (actor.worker) actor.worker.state = 'ready';
        actor.status = 'OPEN_IDLE';
        this.tryDispatch(actor);
        break;

      case 'WORKER_TASK_STARTED':
        if (actor.worker) actor.worker.state = 'busy';
        actor.status = 'OPEN_RUNNING';
        break;

      case 'WORKER_TASK_DONE':
        actor.currentTask = null;
        if (actor.worker) actor.worker.state = 'ready';
        actor.status = 'OPEN_IDLE';
        // tryDispatch will be called when WORKER_READY follows
        break;

      case 'WORKER_TASK_CANCELLED':
        actor.currentTask = null;
        if (actor.worker) actor.worker.state = 'ready';
        actor.status = 'OPEN_IDLE';
        break;

      case 'WORKER_ERROR':
        if (msg.fatal) {
          this.markWorkerDead(actor);
        }
        break;

      case 'WORKER_PROGRESS':
        // Just forward to orchestrator callback
        break;
    }

    // Forward all events to orchestrator for publishing/persistence
    this.options.onWorkerEvent(actor.sessionId, msg);
  }

  /**
   * Try to dispatch the next queued work item if the worker is ready.
   */
  private tryDispatch(actor: SessionActor): void {
    if (!actor.worker || actor.worker.state !== 'ready') return;
    if (actor.currentTask) return;

    // High priority first (Cancel, Close, Status)
    let item = actor.queueHigh.shift();
    if (!item) {
      item = actor.queueNormal.shift();
    }
    if (!item) return;

    // Handle control items inline
    if (item.type === 'CANCEL') {
      this.cancelCurrentTask(actor);
      return;
    }
    if (item.type === 'CLOSE_SESSION') {
      this.closeSession(actor.sessionId);
      return;
    }
    if (item.type === 'STATUS_REQUEST') {
      // Status is handled by orchestrator, not worker — just emit
      this.options.onWorkerEvent(actor.sessionId, {
        type: 'WORKER_READY',
        sessionId: actor.sessionId,
        pid: actor.worker.pid,
      });
      this.tryDispatch(actor); // continue to next item
      return;
    }

    // USER_MESSAGE → dispatch as task
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    actor.currentTask = {
      taskId,
      userEventId: item.eventId,
      startedAt: new Date(),
      cancelRequested: false,
    };

    this.sendToWorker(actor, {
      type: 'WORKER_TASK',
      taskId,
      userEventId: item.eventId,
      prompt: item.content,
    });
  }

  private sendToWorker(actor: SessionActor, msg: OrchestratorToWorker): void {
    if (!actor.worker || actor.worker.state === 'dead') {
      this.logger.warn(`Cannot send to dead worker for session ${actor.sessionId}`);
      return;
    }
    sendIPC(actor.worker.process.stdin!, msg);
  }

  private markWorkerDead(actor: SessionActor): void {
    if (actor.worker) {
      actor.worker.state = 'dead';
    }
    if (actor.currentTask) {
      actor.currentTask = null;
    }
    if (actor.status.startsWith('OPEN_')) {
      actor.status = 'ERRORED';
    }
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* */ }
        resolve();
      }, timeoutMs);

      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
```

**Step 2: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/session-actor.ts
git commit -m "feat: add session actor manager with worker lifecycle and cancel escalation"
```

---

### Task 7: Build the main orchestrator

This replaces `agent.ts`. It wires together: PubNub subscription → inbox dedup → intent parsing → session actor routing → outbox flushing → PubNub publishing.

**Files:**
- Create: `app/orchestrator/orchestrator.ts`
- Create: `app/orchestrator/index.ts`

**Step 1: Create the orchestrator**

Create `app/orchestrator/orchestrator.ts`:

```typescript
/**
 * Main Orchestrator
 *
 * Single process that owns:
 * - PubNub subscription (cmd channel) + publishing (evt channel)
 * - SQLite reads/writes (inbox, outbox, sessions)
 * - Session actor lifecycle and routing
 * - Outbox flush loop for REST persistence
 * - Heartbeat scheduling
 *
 * Replaces the old MiloAgent class.
 */

import type { AgentConfig } from '../config/index.js';
import { WebAppAdapter, PubNubAdapter } from '../messaging/index.js';
import type { PendingMessage } from '../shared/index.js';
import { getDb, closeDb } from '../db/index.js';
import { insertInbox, markProcessed, getUnprocessed } from '../db/inbox.js';
import { enqueueOutbox, getUnsent, markSent, markFailed } from '../db/outbox.js';
import {
  upsertSession,
  updateSessionStatus,
  getActiveSessions,
  insertSessionMessage,
  getSessionMessages,
} from '../db/sessions-db.js';
import { SessionActorManager } from './session-actor.js';
import type { WorkerToOrchestrator } from './ipc-types.js';
import type { WorkItem, WorkItemType } from './session-types.js';
import { parseIntentWithAI } from '../intent/index.js';
import { enhancePrompt } from '../prompt/index.js';
import { complete } from '../utils/ai-client.js';
import { HeartbeatScheduler } from '../scheduler/heartbeat.js';
import { Logger, logger } from '../utils/logger.js';
import { join } from 'path';
import type Database from 'better-sqlite3';

export interface OrchestratorOptions {
  config: AgentConfig;
  apiKey?: string;
  debug?: boolean;
  verbose?: boolean;
}

export class Orchestrator {
  private config: AgentConfig;
  private logger: Logger;
  private db!: Database.Database;
  private restAdapter: WebAppAdapter;
  private pubnubAdapter: PubNubAdapter | null = null;
  private actorManager!: SessionActorManager;
  private scheduler: HeartbeatScheduler;
  private outboxTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private shuttingDown = false;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;

    if (options.apiKey) {
      process.env.MILO_API_KEY = options.apiKey;
    }

    const logLevel = options.debug ? 'debug' : options.verbose ? 'verbose' : 'info';
    this.logger = new Logger({ level: logLevel, prefix: `[${this.config.agentName}]` });
    logger.setLevel(logLevel);

    this.restAdapter = new WebAppAdapter({
      apiUrl: this.config.messaging.webapp.apiUrl,
      apiKey: process.env.MILO_API_KEY || '',
    });

    this.scheduler = new HeartbeatScheduler({
      intervalMinutes: this.config.scheduler.heartbeatIntervalMinutes,
      onHeartbeat: this.handleHeartbeat.bind(this),
    });

    this.setupShutdownHandlers();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.logger.info('Starting orchestrator...');

    // 1. Open SQLite
    this.db = getDb(this.config.workspace.baseDir);
    this.logger.verbose('SQLite database opened');

    // 2. Create session actor manager
    const workerScript = join(import.meta.dirname, 'worker.js');
    this.actorManager = new SessionActorManager({
      workspaceDir: this.config.workspace.baseDir,
      workerScript,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      aiModel: this.config.ai.model,
      logger: this.logger,
      onWorkerEvent: this.handleWorkerEvent.bind(this),
    });

    // 3. Verify connection
    try {
      const hb = await this.restAdapter.sendHeartbeat();
      this.logger.info(`Connected as agent: ${hb.agentId}`);
    } catch (err) {
      this.logger.warn('Could not reach server, will retry:', err);
    }

    // 4. Connect PubNub if enabled
    if (this.config.pubnub.enabled) {
      try {
        this.pubnubAdapter = new PubNubAdapter({
          apiUrl: this.config.messaging.webapp.apiUrl,
          apiKey: process.env.MILO_API_KEY || '',
          onMessage: this.handlePubNubMessage.bind(this),
          logger: this.logger,
        });
        await this.pubnubAdapter.connect();
        await this.pubnubAdapter.publishAgentStatus('Bot is online');
        this.scheduler.setInterval(5);
        this.logger.info('PubNub connected');
      } catch (err) {
        this.logger.warn('PubNub failed, falling back to polling:', err);
        this.pubnubAdapter = null;
      }
    }

    // 5. Catch up on missed messages
    await this.catchUpMessages();

    // 6. Process any unprocessed inbox items (from prior crash)
    this.drainInbox();

    // 7. Start heartbeat + outbox flush
    this.scheduler.start();
    this.outboxTimer = setInterval(() => this.flushOutbox(), 10_000);

    this.isRunning = true;
    this.logger.info('Orchestrator started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning || this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.info('Stopping orchestrator...');

    if (this.pubnubAdapter) {
      await this.pubnubAdapter.publishAgentStatus('Bot is signing off');
      await this.pubnubAdapter.disconnect();
    }

    if (this.outboxTimer) clearInterval(this.outboxTimer);

    await this.actorManager.shutdownAll();

    // Final outbox flush
    await this.flushOutbox();

    this.scheduler.stop();
    closeDb();

    this.isRunning = false;
    this.logger.info('Orchestrator stopped');
  }

  // --- Ingest ---

  /**
   * Handle a message from PubNub (real-time path).
   * Ingest-first: dedup → inbox → fast receipt → route.
   */
  private async handlePubNubMessage(message: PendingMessage): Promise<void> {
    this.logger.info(`PubNub message: ${message.id}`);

    // 1. Dedup + persist to inbox
    const isNew = insertInbox(this.db, {
      event_id: message.id,
      session_id: message.sessionId,
      session_type: message.sessionType || 'bot',
      content: message.content,
      session_name: message.sessionName ?? undefined,
    });

    if (!isNew) {
      this.logger.verbose(`Duplicate event ${message.id}, skipping`);
      return;
    }

    // 2. Publish fast receipt
    if (this.pubnubAdapter) {
      await this.pubnubAdapter.sendMessage('Message received. Processing...', message.sessionId);
    }

    // 3. Enqueue REST ack in outbox
    enqueueOutbox(this.db, 'ack_message', { messageIds: [message.id] }, message.sessionId);

    // 4. Route to session
    await this.routeMessage(message);

    // 5. Mark inbox processed
    markProcessed(this.db, message.id);
  }

  /**
   * Catch up on messages missed while offline (REST fetch).
   */
  private async catchUpMessages(): Promise<void> {
    try {
      const pending = await this.restAdapter.getPendingMessages();
      if (pending.length === 0) return;

      this.logger.info(`Catching up on ${pending.length} missed messages`);
      for (const msg of pending) {
        // Dedup via inbox
        const isNew = insertInbox(this.db, {
          event_id: msg.id,
          session_id: msg.sessionId,
          session_type: msg.sessionType || 'bot',
          content: msg.content,
          session_name: msg.sessionName ?? undefined,
        });
        if (isNew) {
          await this.routeMessage(msg);
          markProcessed(this.db, msg.id);
        }
      }
      await this.restAdapter.acknowledgeMessages(pending.map((m) => m.id));
    } catch (err) {
      this.logger.warn('Catch-up failed:', err);
    }
  }

  /**
   * Drain any unprocessed inbox items (crash recovery).
   */
  private drainInbox(): void {
    const items = getUnprocessed(this.db);
    if (items.length === 0) return;

    this.logger.info(`Draining ${items.length} unprocessed inbox items`);
    for (const item of items) {
      const msg: PendingMessage = {
        id: item.event_id,
        sessionId: item.session_id,
        sessionName: item.session_name ?? null,
        sessionType: (item.session_type as 'chat' | 'bot') || 'bot',
        content: item.content,
        createdAt: item.received_at,
      };
      // Fire-and-forget since these are recovery items
      this.routeMessage(msg).then(() => markProcessed(this.db, item.event_id));
    }
  }

  // --- Routing ---

  /**
   * Route a message to the appropriate session actor.
   * Derives intent (UI action or plain-text parsing) and enqueues a work item.
   */
  private async routeMessage(message: PendingMessage): Promise<void> {
    // Store in session messages table
    insertSessionMessage(this.db, message.sessionId, 'user', message.content, message.id);

    // Derive work item type
    const workItemType = await this.deriveWorkItemType(message);

    // Ensure session exists in DB
    upsertSession(this.db, {
      sessionId: message.sessionId,
      sessionName: message.sessionName ?? undefined,
      sessionType: message.sessionType || 'bot',
      status: 'OPEN_IDLE',
    });

    // Determine project path
    const projectPath = this.config.workspace.baseDir;

    // Get or create actor (spawns worker if needed)
    const actor = await this.actorManager.getOrCreate(message.sessionId, {
      sessionName: message.sessionName ?? message.sessionId,
      sessionType: (message.sessionType as 'chat' | 'bot') || 'bot',
      projectPath,
    });

    // Enqueue work item
    const isControl = ['CANCEL', 'CLOSE_SESSION', 'STATUS_REQUEST'].includes(workItemType);
    const workItem: WorkItem = {
      id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: workItemType,
      eventId: message.id,
      sessionId: message.sessionId,
      content: message.content,
      priority: isControl ? 'high' : 'normal',
      createdAt: new Date(),
    };

    this.actorManager.enqueue(message.sessionId, workItem);
    this.logger.verbose(`Enqueued ${workItemType} for session ${message.sessionId}`);
  }

  /**
   * Derive the internal WorkItemType from a message.
   * UI actions take precedence, then pattern/AI intent parsing.
   */
  private async deriveWorkItemType(message: PendingMessage): Promise<WorkItemType> {
    // Check for UI action in content (simple heuristic for now)
    const lower = message.content.toLowerCase().trim();

    if (lower === 'cancel' || lower === '/cancel') return 'CANCEL';
    if (lower === 'close' || lower === '/close' || lower === 'close session') return 'CLOSE_SESSION';
    if (lower === 'status' || lower === '/status') return 'STATUS_REQUEST';

    // Default: user message (the worker + intent parser will handle the specifics)
    return 'USER_MESSAGE';
  }

  // --- Worker Events ---

  /**
   * Handle events from worker processes.
   * Publish via PubNub and enqueue for REST persistence.
   */
  private handleWorkerEvent(sessionId: string, event: WorkerToOrchestrator): void {
    switch (event.type) {
      case 'WORKER_TASK_DONE': {
        // Save agent response to session messages
        if (event.output) {
          insertSessionMessage(this.db, sessionId, 'agent', event.output);
        }

        // Publish to user
        const content = event.success
          ? event.output ?? 'Task completed.'
          : `Error: ${event.error ?? 'Unknown error'}`;
        this.publishEvent(sessionId, 'agent_message', content);

        // Update session status in DB
        updateSessionStatus(this.db, sessionId, 'OPEN_IDLE');

        // Enqueue for REST persistence
        enqueueOutbox(this.db, 'send_message', {
          sessionId,
          content,
        }, sessionId);
        break;
      }

      case 'WORKER_TASK_CANCELLED':
        this.publishEvent(sessionId, 'task_cancelled', 'Task was cancelled.');
        updateSessionStatus(this.db, sessionId, 'OPEN_IDLE');
        break;

      case 'WORKER_ERROR':
        this.publishEvent(sessionId, 'error', event.error);
        if (event.fatal) {
          updateSessionStatus(this.db, sessionId, 'ERRORED');
        }
        break;

      case 'WORKER_TASK_STARTED':
        updateSessionStatus(this.db, sessionId, 'OPEN_RUNNING');
        this.publishEvent(sessionId, 'session_status_changed', 'OPEN_RUNNING');
        break;

      case 'WORKER_READY':
        // No-op for publishing; actor manager handles dispatch
        break;

      case 'WORKER_PROGRESS':
        this.publishEvent(sessionId, 'agent_message', event.message);
        break;
    }
  }

  // --- Publishing ---

  /**
   * Publish an event to the user via PubNub (single publisher).
   */
  private publishEvent(
    sessionId: string,
    type: string,
    content: string
  ): void {
    if (this.pubnubAdapter?.isConnected) {
      this.pubnubAdapter.sendMessage(content, sessionId).catch((err) => {
        this.logger.warn('PubNub publish failed:', err);
      });
    }
  }

  // --- Outbox Flush ---

  /**
   * Flush unsent outbox items to the REST API.
   */
  private async flushOutbox(): Promise<void> {
    const items = getUnsent(this.db);
    if (items.length === 0) return;

    this.logger.verbose(`Flushing ${items.length} outbox items`);

    for (const item of items) {
      try {
        const payload = JSON.parse(item.payload);

        switch (item.event_type) {
          case 'ack_message':
            await this.restAdapter.acknowledgeMessages(payload.messageIds);
            break;
          case 'send_message':
            await this.restAdapter.sendMessage(payload.content, payload.sessionId);
            break;
          default:
            this.logger.warn(`Unknown outbox event type: ${item.event_type}`);
        }

        markSent(this.db, item.id);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        markFailed(this.db, item.id, error);
        this.logger.debug(`Outbox item ${item.id} failed: ${error}`);
      }
    }
  }

  // --- Heartbeat ---

  private async handleHeartbeat(): Promise<void> {
    try {
      const activeSessions = getActiveSessions(this.db);
      const names = activeSessions.map((s) => s.session_name ?? s.session_id);
      await this.restAdapter.sendHeartbeat(names);

      // If no PubNub, poll for messages
      if (!this.pubnubAdapter?.isConnected) {
        const pending = await this.restAdapter.getPendingMessages();
        for (const msg of pending) {
          const isNew = insertInbox(this.db, {
            event_id: msg.id,
            session_id: msg.sessionId,
            session_type: msg.sessionType || 'bot',
            content: msg.content,
            session_name: msg.sessionName ?? undefined,
          });
          if (isNew) {
            await this.routeMessage(msg);
            markProcessed(this.db, msg.id);
          }
        }
        if (pending.length > 0) {
          await this.restAdapter.acknowledgeMessages(pending.map((m) => m.id));
        }
      }
    } catch (err) {
      this.logger.error('Heartbeat failed:', err);
    }
  }

  // --- Shutdown ---

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.logger.info(`Received ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // --- Status ---

  getStatus() {
    return {
      running: this.isRunning,
      activeSessions: this.actorManager?.listActive().length ?? 0,
    };
  }
}
```

**Step 2: Create the index barrel**

Create `app/orchestrator/index.ts`:

```typescript
export { Orchestrator } from './orchestrator.js';
export type { OrchestratorOptions } from './orchestrator.js';
export { SessionActorManager } from './session-actor.js';
export type * from './ipc-types.js';
export type * from './session-types.js';
```

**Step 3: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/orchestrator.ts app/orchestrator/index.ts
git commit -m "feat: add main orchestrator with ingest-first pipeline and outbox flush"
```

---

### Task 8: Wire orchestrator into CLI entry point

**Files:**
- Modify: `app/commands/start.ts`

**Step 1: Read the current start command**

Read `app/commands/start.ts` to understand the current wiring.

**Step 2: Replace MiloAgent with Orchestrator**

Replace the `MiloAgent` import and instantiation with `Orchestrator`. The constructor signatures are nearly identical (`config`, `apiKey`, `debug`, `verbose`).

Change:
```typescript
import { MiloAgent } from '../agent.js';
// ...
const agent = new MiloAgent({ config, apiKey, debug, verbose });
await agent.start();
```

To:
```typescript
import { Orchestrator } from '../orchestrator/index.js';
// ...
const orchestrator = new Orchestrator({ config, apiKey, debug, verbose });
await orchestrator.start();
```

The rest of the start command (config loading, workspace checks, flags) stays the same.

**Step 3: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/commands/start.ts
git commit -m "feat: wire orchestrator into CLI start command"
```

---

### Task 9: Write integration test for IPC protocol

Verify that a worker can be spawned, initialized, given a task, and responds correctly via JSON Lines.

**Files:**
- Create: `__tests__/orchestrator/ipc.test.ts`

**Step 1: Write the test**

Create `__tests__/orchestrator/ipc.test.ts`:

```typescript
import { sendIPC, readIPC } from '../../app/orchestrator/ipc.js';
import { PassThrough } from 'stream';
import type { IPCMessage } from '../../app/orchestrator/ipc-types.js';

describe('IPC helpers', () => {
  test('sendIPC writes JSON line to stream', () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk) => chunks.push(chunk.toString()));

    const msg: IPCMessage = {
      type: 'WORKER_READY',
      sessionId: 'test-session',
      pid: 1234,
    };

    sendIPC(stream, msg);
    stream.end();

    const written = chunks.join('');
    expect(written).toBe(JSON.stringify(msg) + '\n');
  });

  test('readIPC yields parsed messages from stream', async () => {
    const stream = new PassThrough();

    const msg1: IPCMessage = { type: 'WORKER_READY', sessionId: 's1', pid: 1 };
    const msg2: IPCMessage = { type: 'WORKER_TASK_STARTED', taskId: 't1', sessionId: 's1' };

    stream.write(JSON.stringify(msg1) + '\n');
    stream.write(JSON.stringify(msg2) + '\n');
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(msg1);
    expect(messages[1]).toEqual(msg2);
  });

  test('readIPC skips malformed lines', async () => {
    const stream = new PassThrough();

    stream.write('not json\n');
    stream.write(JSON.stringify({ type: 'WORKER_READY', sessionId: 's1', pid: 1 }) + '\n');
    stream.end();

    const messages: IPCMessage[] = [];
    for await (const m of readIPC(stream)) {
      messages.push(m);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('WORKER_READY');
  });
});
```

**Step 2: Run the test**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/orchestrator/ipc.test.ts`
Expected: 3 tests pass

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add __tests__/orchestrator/ipc.test.ts
git commit -m "test: add IPC protocol unit tests"
```

---

### Task 10: Write integration test for inbox dedup

**Files:**
- Create: `__tests__/db/inbox.test.ts`

**Step 1: Write the test**

Create `__tests__/db/inbox.test.ts`:

```typescript
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
      event_id: 'evt-1',
      session_id: 'sess-1',
      session_type: 'bot',
      content: 'hello',
    });
    expect(result).toBe(true);
  });

  test('insertInbox returns false for duplicate event_id', () => {
    insertInbox(db, {
      event_id: 'evt-1',
      session_id: 'sess-1',
      session_type: 'bot',
      content: 'hello',
    });
    const result = insertInbox(db, {
      event_id: 'evt-1',
      session_id: 'sess-1',
      session_type: 'bot',
      content: 'hello again',
    });
    expect(result).toBe(false);
  });

  test('getUnprocessed returns only unprocessed items', () => {
    insertInbox(db, { event_id: 'evt-1', session_id: 's1', session_type: 'bot', content: 'a' });
    insertInbox(db, { event_id: 'evt-2', session_id: 's1', session_type: 'bot', content: 'b' });
    markProcessed(db, 'evt-1');

    const unprocessed = getUnprocessed(db);
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].event_id).toBe('evt-2');
  });
});
```

**Step 2: Run the test**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/db/inbox.test.ts`
Expected: 3 tests pass

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add __tests__/db/inbox.test.ts
git commit -m "test: add inbox dedup unit tests"
```

---

### Task 11: Write integration test for outbox flush

**Files:**
- Create: `__tests__/db/outbox.test.ts`

**Step 1: Write the test**

Create `__tests__/db/outbox.test.ts`:

```typescript
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
});
```

**Step 2: Run the test**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/db/outbox.test.ts`
Expected: 3 tests pass

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add __tests__/db/outbox.test.ts
git commit -m "test: add outbox flush unit tests"
```

---

### Task 12: Update `app/index.ts` exports and keep old agent as fallback

**Files:**
- Modify: `app/index.ts`

**Step 1: Read current index.ts**

Read `app/index.ts` to see current exports.

**Step 2: Add orchestrator exports alongside existing agent exports**

Add:
```typescript
// New orchestrator
export { Orchestrator } from './orchestrator/index.js';
```

Keep the old `MiloAgent` export so it can still be used if needed during migration.

**Step 3: Run typecheck + build**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck && pnpm build`
Expected: Both succeed

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/index.ts
git commit -m "feat: export orchestrator from package index"
```

---

### Task 13: Manual smoke test

**Step 1: Build the agent**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm build`
Expected: Clean build

**Step 2: Start in dev mode**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm dev`
Expected:
- "Starting orchestrator..." appears
- "SQLite database opened" appears
- PubNub connects (or falls back gracefully)
- "Orchestrator started" appears
- DB file created at `~/milo-workspace/.milo/agent.db`

**Step 3: Send a test message from the web app**

Send a message through the web UI. Verify:
- Message appears in inbox (check with `sqlite3 ~/milo-workspace/.milo/agent.db "SELECT * FROM inbox"`)
- Worker spawns for the session
- Response is published back via PubNub
- Outbox entry is created and flushed

**Step 4: Test cancel**

Send "cancel" in the same session. Verify:
- Cancel is routed as high-priority
- Worker receives WORKER_CANCEL
- Task is cancelled (or "nothing to cancel" if idle)

**Step 5: Commit any fixes**

---

### Task 14: Clean up old agent.ts (deferred)

Once the orchestrator is validated end-to-end:

1. Rename `app/agent.ts` → `app/agent.legacy.ts`
2. Remove old `session/manager.ts` (markdown-based sessions)
3. Remove old `task/orchestrator.ts` (in-process task DAG)
4. Update all imports
5. Run `pnpm typecheck && pnpm test`

**Do not do this until the new orchestrator is fully working.** Keep the old code available for reference and fallback.

---

## Migration Risk Summary

| Risk | Mitigation |
|------|-----------|
| `better-sqlite3` is a native module (needs compilation) | It's one of the most popular Node native modules; pre-built binaries available for macOS/Linux/Windows |
| Worker process crashes lose in-flight task | Inbox is durable — on restart, orchestrator drains unprocessed items |
| PubNub token refresh during worker task | Token refresh is orchestrator-only; workers don't use PubNub |
| Large chat history passed via IPC | Truncate to last N messages in orchestrator before sending WORKER_TASK context |
| Worker stdout pollution (e.g., Claude Code SDK logs) | SDK logging should go to stderr; stdout is reserved for IPC JSON Lines |

---

## Architecture Diagram (Final State)

```
                         ┌─────────────┐
                         │   Web App   │
                         │  (Vercel)   │
                         └──────┬──────┘
                                │
                    PubNub cmd  │  PubNub evt
                    ────────────┼────────────
                                │
                    ┌───────────┴───────────┐
                    │     ORCHESTRATOR      │
                    │                       │
                    │  PubNub subscriber    │
                    │  PubNub publisher     │
                    │  SQLite (inbox/outbox)│
                    │  Session actor mgr    │
                    │  REST adapter         │
                    │  Heartbeat scheduler  │
                    └───┬───────┬───────┬───┘
                        │       │       │
                    IPC(JSON Lines over stdin/stdout)
                        │       │       │
                    ┌───┴──┐┌──┴───┐┌──┴───┐
                    │Worker││Worker││Worker│
                    │sess-1││sess-2││sess-3│
                    │      ││      ││      │
                    │Claude││Chat  ││Claude│
                    │ Code ││  AI  ││ Code │
                    └──────┘└──────┘└──────┘
```
