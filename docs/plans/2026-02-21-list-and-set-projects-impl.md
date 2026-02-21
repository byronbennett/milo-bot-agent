# List Projects & Set Project Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two features: (1) natural language "list projects" command that returns PROJECTS/ folder listing from any chat context, and (2) a "Set Project" UI button in session chat that sends a form for multi-project selection.

**Architecture:** Both features are handled inline by the orchestrator (no worker/AI needed). List Projects reads the PROJECTS/ directory and responds with text. Set Project sends a FormDefinition with checkboxes, handles the response to update the session's confirmed projects, and notifies the running worker via a new IPC message.

**Tech Stack:** TypeScript, PubNub, SQLite (better-sqlite3), existing FormDefinition system, existing IPC protocol.

---

### Task 1: Add `list_projects` Intent Type and Patterns

**Files:**
- Modify: `app/shared/types.ts:220-230`
- Modify: `app/intent/patterns.ts`
- Test: `__tests__/intent/parser.test.ts`

**Step 1: Write the failing tests**

Add to `__tests__/intent/parser.test.ts`:

```typescript
it('parses list_projects intent for "list projects"', () => {
  const message = createMessage('list projects');
  const result = parseIntent(message, mockConfig);
  expect(result.type).toBe('list_projects');
  expect(result.confidence).toBeGreaterThanOrEqual(0.9);
});

it('parses list_projects intent for "what projects are there"', () => {
  const message = createMessage('what projects are there');
  const result = parseIntent(message, mockConfig);
  expect(result.type).toBe('list_projects');
});

it('parses list_projects intent for "/projects"', () => {
  const message = createMessage('/projects');
  const result = parseIntent(message, mockConfig);
  expect(result.type).toBe('list_projects');
});

it('parses list_projects intent for "show projects"', () => {
  const message = createMessage('show projects');
  const result = parseIntent(message, mockConfig);
  expect(result.type).toBe('list_projects');
});
```

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/intent/parser.test.ts -v`
Expected: FAIL — `list_projects` is not a valid IntentType.

**Step 3: Add `list_projects` to IntentType**

In `app/shared/types.ts`, add `'list_projects'` to the `IntentType` union (after `'list_sessions'`):

```typescript
export type IntentType =
  | 'create_project'
  | 'open_session'
  | 'send_message'
  | 'answer_question'
  | 'question'
  | 'greeting'
  | 'list_sessions'
  | 'list_projects'
  | 'cancel_session'
  | 'set_rule'
  | 'unknown';
```

**Step 4: Add pattern matching for list_projects**

In `app/intent/patterns.ts`, add after the `GREETING_PATTERNS` section:

```typescript
/**
 * Patterns for listing projects
 */
const LIST_PROJECTS_PATTERNS = [
  /^\/projects$/i,
  /^(list|show|get)\s+(the\s+)?projects?\s*(list|folders?)?$/i,
  /^what\s+projects?\s+(are\s+there|do\s+(i|we)\s+have|exist)/i,
  /^projects?\s*$/i,
];

/**
 * Check if content is a list-projects request
 */
export function matchListProjectsPatterns(content: string): boolean {
  const trimmed = content.trim();
  return LIST_PROJECTS_PATTERNS.some((p) => p.test(trimmed));
}
```

**Step 5: Wire pattern into parser**

In `app/intent/parser.ts`, import `matchListProjectsPatterns` and add a check before the open_session pattern matching (after the `sessionId` check, before pattern matching):

```typescript
import {
  matchOpenSessionPatterns,
  matchGreetingPatterns,
  matchListProjectsPatterns,
  resolveProjectAlias,
  generateSessionName,
  looksLikeTask,
} from './patterns';
```

In `parseIntent()`, add after the sessionId check (Case 1) and before the pattern matching (Case 2):

```typescript
// Case 1.5: Check for list_projects command
if (matchListProjectsPatterns(content)) {
  logger.verbose('  Intent: list_projects pattern matched');
  return {
    type: 'list_projects',
    confidence: 0.95,
    raw: content,
  };
}
```

**Step 6: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/intent/parser.test.ts -v`
Expected: PASS

**Step 7: Commit**

```bash
git add app/shared/types.ts app/intent/patterns.ts app/intent/parser.ts __tests__/intent/parser.test.ts
git commit -m "feat(intent): add list_projects intent type and pattern matching"
```

---

### Task 2: Add `LIST_PROJECTS` and `SET_PROJECT` Work Item Types

**Files:**
- Modify: `app/orchestrator/session-types.ts:17-24`

**Step 1: Add new work item types**

In `app/orchestrator/session-types.ts`, add `'LIST_PROJECTS'` and `'SET_PROJECT'` to the `WorkItemType` union:

```typescript
export type WorkItemType =
  | 'USER_MESSAGE'
  | 'CANCEL'
  | 'CLOSE_SESSION'
  | 'STATUS_REQUEST'
  | 'LIST_MODELS'
  | 'LIST_PROJECTS'
  | 'SET_PROJECT'
  | 'CLEAR_MEMORY'
  | 'COMPACT_MEMORY';
```

**Step 2: Commit**

```bash
git add app/orchestrator/session-types.ts
git commit -m "feat(orchestrator): add LIST_PROJECTS and SET_PROJECT work item types"
```

---

### Task 3: Add `WORKER_UPDATE_PROJECTS` IPC Message

**Files:**
- Modify: `app/orchestrator/ipc-types.ts`

**Step 1: Add the new IPC message type**

In `app/orchestrator/ipc-types.ts`, add after `WorkerCompactContextMessage`:

```typescript
export interface WorkerUpdateProjectsMessage {
  type: 'WORKER_UPDATE_PROJECTS';
  sessionId: string;
  projectPaths: string[];
  primaryProjectPath: string;
}
```

Add `WorkerUpdateProjectsMessage` to the `OrchestratorToWorker` union:

```typescript
export type OrchestratorToWorker =
  | WorkerInitMessage
  | WorkerTaskMessage
  | WorkerCancelMessage
  | WorkerCloseMessage
  | WorkerSteerMessage
  | WorkerAnswerMessage
  | WorkerFormResponseMessage
  | WorkerClearContextMessage
  | WorkerCompactContextMessage
  | WorkerUpdateProjectsMessage;
```

**Step 2: Commit**

```bash
git add app/orchestrator/ipc-types.ts
git commit -m "feat(ipc): add WORKER_UPDATE_PROJECTS message type"
```

---

### Task 4: Update DB Layer for Multi-Project Support

**Files:**
- Modify: `app/db/sessions-db.ts:66-75`
- Test: create `__tests__/db/sessions-db.test.ts`

**Step 1: Write the failing tests**

Create `__tests__/db/sessions-db.test.ts`:

```typescript
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
    // Simulate old single-project format (plain string, not JSON)
    db.prepare(`UPDATE sessions SET confirmed_project = ? WHERE session_id = ?`).run('legacy-project', 'sess-1');
    const projects = getConfirmedProjects(db, 'sess-1');
    expect(projects).toEqual(['legacy-project']);
  });

  it('getConfirmedProject returns plain string for backward compat', () => {
    db.prepare(`UPDATE sessions SET confirmed_project = ? WHERE session_id = ?`).run('legacy-project', 'sess-1');
    const project = getConfirmedProject(db, 'sess-1');
    expect(project).toBe('legacy-project');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/db/sessions-db.test.ts -v`
Expected: FAIL — `updateConfirmedProjects` and `getConfirmedProjects` don't exist.

**Step 3: Add multi-project functions to sessions-db**

In `app/db/sessions-db.ts`, add after the existing `getConfirmedProject` function:

```typescript
export function updateConfirmedProjects(db: Database.Database, sessionId: string, projectNames: string[]): void {
  const value = JSON.stringify(projectNames);
  db.prepare(`
    UPDATE sessions SET confirmed_project = ?, updated_at = datetime('now') WHERE session_id = ?
  `).run(value, sessionId);
}

export function getConfirmedProjects(db: Database.Database, sessionId: string): string[] {
  const row = db.prepare(`SELECT confirmed_project FROM sessions WHERE session_id = ?`).get(sessionId) as { confirmed_project?: string } | undefined;
  const raw = row?.confirmed_project;
  if (!raw) return [];
  // Try JSON array first (new format), fall back to plain string (old format)
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  return [raw];
}
```

Update `getConfirmedProject` for backward compat with new JSON format:

```typescript
export function getConfirmedProject(db: Database.Database, sessionId: string): string | undefined {
  const projects = getConfirmedProjects(db, sessionId);
  return projects[0] ?? undefined;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/db/sessions-db.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add app/db/sessions-db.ts __tests__/db/sessions-db.test.ts
git commit -m "feat(db): add multi-project support to sessions-db"
```

---

### Task 5: Add LIST_PROJECTS Handling in Orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`

**Step 1: Add `LIST_PROJECTS` to `deriveWorkItemType()`**

In the uiAction section (after the `COMPACT_MEMORY` check at line 756):

```typescript
if (action === 'LIST_PROJECTS') return 'LIST_PROJECTS';
if (action === 'SET_PROJECT') return 'SET_PROJECT';
```

In the text pattern matching section (after the `/models` check at line 764), add:

```typescript
if (lower === '/projects' || lower === 'projects' || lower === 'list projects') return 'LIST_PROJECTS';
```

**Step 2: Import `readdirSync` and add to existing fs import**

At the top of the file, the existing import `import { existsSync, unlinkSync, mkdirSync } from 'fs';` — add `readdirSync`:

```typescript
import { existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
```

**Step 3: Add `LIST_PROJECTS` inline handler in `handleMessage()`**

After the `STATUS_REQUEST` handler (after line 689), add:

```typescript
// LIST_PROJECTS doesn't need a session/worker — handle inline
if (workItemType === 'LIST_PROJECTS') {
  const projectsRoot = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
  let projectNames: string[] = [];
  if (existsSync(projectsRoot)) {
    projectNames = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  }

  const text = projectNames.length > 0
    ? `Projects (${projectNames.length}):\n${projectNames.map((n) => `- ${n}`).join('\n')}`
    : 'No projects found in PROJECTS/. Create one by starting a coding session.';

  this.publishEvent(message.sessionId, text);
  enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: text }, message.sessionId);
  return;
}
```

**Step 4: Add `LIST_PROJECTS` and `SET_PROJECT` to the isControl array**

At line 726, update the control types array:

```typescript
const isControl = ['CANCEL', 'CLOSE_SESSION', 'STATUS_REQUEST', 'LIST_MODELS', 'LIST_PROJECTS', 'SET_PROJECT', 'CLEAR_MEMORY', 'COMPACT_MEMORY'].includes(workItemType);
```

**Step 5: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): handle LIST_PROJECTS inline with directory listing"
```

---

### Task 6: Add SET_PROJECT Form Sending in Orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`

**Step 1: Import `randomUUID`**

Add to the top of the file:

```typescript
import { randomUUID } from 'crypto';
```

**Step 2: Import `updateConfirmedProjects` and `getConfirmedProjects`**

Update the sessions-db import:

```typescript
import {
  upsertSession,
  updateSessionStatus,
  updateWorkerState,
  updateConfirmedProject,
  updateConfirmedProjects,
  getActiveSessions,
  getConfirmedProject,
  getConfirmedProjects,
  insertSessionMessage,
} from '../db/sessions-db.js';
```

**Step 3: Import FormDefinition type**

```typescript
import type { FormDefinition } from '../shared/form-types.js';
```

**Step 4: Add SET_PROJECT inline handler**

After the `LIST_PROJECTS` handler added in Task 5, add:

```typescript
// SET_PROJECT doesn't need a worker — orchestrator sends form and handles response
if (workItemType === 'SET_PROJECT') {
  const projectsRoot = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
  let projectNames: string[] = [];
  if (existsSync(projectsRoot)) {
    projectNames = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  }

  if (projectNames.length === 0) {
    const text = 'No projects found in PROJECTS/. Create a project folder first.';
    this.publishEvent(message.sessionId, text);
    enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: text }, message.sessionId);
    return;
  }

  // Get currently confirmed projects for this session to set defaults
  const currentProjects = getConfirmedProjects(this.db, message.sessionId);

  const formId = randomUUID();
  const formDefinition: FormDefinition = {
    formId,
    title: 'Select Projects',
    description: 'Choose which projects this session should have access to.',
    critical: false,
    status: 'pending',
    fields: projectNames.map((name) => ({
      type: 'checkbox' as const,
      name: name.replace(/[^a-zA-Z0-9_]/g, '_'),
      label: name,
      required: false,
      defaultValue: currentProjects.includes(name),
    })),
    submitLabel: 'Set Projects',
  };

  // Track with orchestrator prefix so form response handler knows not to forward to worker
  this.pendingForms.set(formId, {
    formId,
    sessionId: message.sessionId,
    taskId: `orchestrator:set_project`,
  });

  // Publish form to browser
  if (this.pubnubAdapter) {
    this.pubnubAdapter.publishEvent({
      type: 'form_request',
      agentId: this.agentId,
      sessionId: message.sessionId,
      formDefinition,
      timestamp: new Date().toISOString(),
    }).catch((err) => {
      this.logger.warn('PubNub form_request publish failed:', err);
    });
  }

  // Persist form as message
  const formContent = JSON.stringify(formDefinition);
  insertSessionMessage(this.db, message.sessionId, 'agent', formContent);
  enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: formContent, formData: formDefinition }, message.sessionId);
  return;
}
```

**Step 5: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): send project selection form for SET_PROJECT action"
```

---

### Task 7: Handle SET_PROJECT Form Response in Orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`

**Step 1: Update the form_response handler in `handlePubNubControl()`**

In the `form_response` handling block (around line 329-361), add orchestrator form handling before the worker forwarding. Replace the existing block with:

```typescript
// Handle form responses from browser
if (message.type === 'form_response') {
  const formMsg = message as unknown as PubNubFormResponseCommand;
  const pending = this.pendingForms.get(formMsg.formId);
  if (!pending) {
    this.logger.warn(`Received form_response for unknown formId: ${formMsg.formId}`);
    return;
  }
  // Clear pending form
  this.pendingForms.delete(formMsg.formId);

  // Check if this is an orchestrator-owned form
  if (pending.taskId.startsWith('orchestrator:')) {
    await this.handleOrchestratorFormResponse(pending, formMsg);
    return;
  }

  // Forward to worker
  this.actorManager.sendFormResponse(pending.sessionId, {
    type: 'WORKER_FORM_RESPONSE',
    sessionId: pending.sessionId,
    taskId: pending.taskId,
    formId: formMsg.formId,
    response: formMsg.status === 'submitted'
      ? { formId: formMsg.formId, status: 'submitted' as const, values: formMsg.values ?? {} }
      : { formId: formMsg.formId, status: 'cancelled' as const },
  });
  // Update session status
  const newStatus = formMsg.status === 'submitted' ? 'OPEN_RUNNING' : 'OPEN_IDLE';
  updateSessionStatus(this.db, pending.sessionId, newStatus);
  // Publish status change
  if (this.pubnubAdapter) {
    await this.pubnubAdapter.publishEvent({
      type: 'session_status_changed',
      agentId: this.agentId,
      sessionId: pending.sessionId,
      sessionStatus: newStatus,
      timestamp: new Date().toISOString(),
    });
  }
  return;
}
```

**Step 2: Add the `handleOrchestratorFormResponse` method**

Add this private method to the Orchestrator class:

```typescript
/**
 * Handle form responses for orchestrator-owned forms (not worker forms).
 */
private async handleOrchestratorFormResponse(
  pending: { formId: string; sessionId: string; taskId: string },
  formMsg: PubNubFormResponseCommand,
): Promise<void> {
  const { sessionId } = pending;

  if (pending.taskId === 'orchestrator:set_project') {
    if (formMsg.status !== 'submitted' || !formMsg.values) {
      const text = 'Project selection cancelled.';
      this.publishEvent(sessionId, text);
      enqueueOutbox(this.db, 'send_message', { sessionId, content: text }, sessionId);
      return;
    }

    // Read PROJECTS/ to build name mapping (field names have underscores, folder names may have hyphens)
    const projectsRoot = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
    let projectNames: string[] = [];
    if (existsSync(projectsRoot)) {
      projectNames = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    }

    // Build reverse mapping: sanitized field name → actual folder name
    const fieldToFolder = new Map<string, string>();
    for (const name of projectNames) {
      fieldToFolder.set(name.replace(/[^a-zA-Z0-9_]/g, '_'), name);
    }

    // Extract selected projects
    const selectedProjects: string[] = [];
    for (const [fieldName, value] of Object.entries(formMsg.values)) {
      if (value === true) {
        const folderName = fieldToFolder.get(fieldName);
        if (folderName) selectedProjects.push(folderName);
      }
    }

    if (selectedProjects.length === 0) {
      const text = 'No projects selected. Tools requiring a project will be blocked until you set one.';
      this.publishEvent(sessionId, text);
      enqueueOutbox(this.db, 'send_message', { sessionId, content: text }, sessionId);
      return;
    }

    // Update DB
    updateConfirmedProjects(this.db, sessionId, selectedProjects);

    // Update actor's projectPath to primary (first selected)
    const primaryPath = join(projectsRoot, selectedProjects[0]);
    const actor = this.actorManager.get(sessionId);
    if (actor) {
      actor.projectPath = primaryPath;
    }

    // Notify running worker
    const allPaths = selectedProjects.map((n) => join(projectsRoot, n));
    this.actorManager.sendToWorker(sessionId, {
      type: 'WORKER_UPDATE_PROJECTS',
      sessionId,
      projectPaths: allPaths,
      primaryProjectPath: primaryPath,
    });

    // Confirm to user
    const projectList = selectedProjects.join(', ');
    const text = selectedProjects.length === 1
      ? `Project set: **${selectedProjects[0]}**`
      : `Projects set: **${projectList}**`;
    this.publishEvent(sessionId, text);
    enqueueOutbox(this.db, 'send_message', { sessionId, content: text }, sessionId);
    this.logger.info(`Set projects [${projectList}] for session ${sessionId}`);
  }
}
```

**Step 3: Expose `sendToWorker` on SessionActorManager**

Check if `sendToWorker` already exists. If not, it needs to be added. The existing `sendFormResponse` sends IPC to the worker — we need a generic equivalent. Looking at the code, the `sendIPC` call is in a private `sendToWorker` method in session-actor.ts. We need to either make it public or add a new public method.

In `app/orchestrator/session-actor.ts`, find the existing private `sendToWorker` method and make it public (or add a public wrapper):

```typescript
public sendToWorker(sessionId: string, msg: OrchestratorToWorker): void {
  const actor = this.actors.get(sessionId);
  if (!actor?.worker || actor.worker.state === 'dead') {
    this.logger.warn(`Cannot send to dead/missing worker for session ${sessionId}`);
    return;
  }
  sendIPC(actor.worker.process.stdin!, msg);
}
```

If `sendToWorker` is already private, just change `private` to `public`. If it has a different signature, add a new public method.

**Step 4: Commit**

```bash
git add app/orchestrator/orchestrator.ts app/orchestrator/session-actor.ts
git commit -m "feat(orchestrator): handle SET_PROJECT form response with multi-project support"
```

---

### Task 8: Handle WORKER_UPDATE_PROJECTS in Worker

**Files:**
- Modify: `app/orchestrator/worker.ts`

**Step 1: Add handler for the new IPC message**

In the worker's IPC message switch (around line 590), add a case for `WORKER_UPDATE_PROJECTS`:

```typescript
case 'WORKER_UPDATE_PROJECTS':
  projectPath = msg.primaryProjectPath;
  confirmedProjectPaths = msg.projectPaths;
  log(`Projects updated: primary=${msg.primaryProjectPath}, all=[${msg.projectPaths.join(', ')}]`);
  break;
```

**Step 2: Add `confirmedProjectPaths` state variable**

Near the top of the worker (around line 33, near the other state variables), add:

```typescript
let confirmedProjectPaths: string[] = [];
```

**Step 3: Pass confirmedProjectPaths to tool context**

In the tool loading section where `loadTools` is called (around line 202), the `ToolContext` is built. We need to expose `confirmedProjectPaths` so the project guard can use it. Add a new field to the context object.

In `app/agent-tools/index.ts`, add to the `ToolContext` interface:

```typescript
confirmedProjectPaths?: string[];
```

Then in the worker where tools are loaded, pass it:

```typescript
const tools = loadTools(toolSet as any, {
  projectPath,
  workspaceDir,
  sessionId,
  sessionName,
  currentTaskId: () => currentTaskId,
  preferAPIKeyClaude: initConfig.preferAPIKeyClaude,
  confirmedProjectPaths: () => confirmedProjectPaths,
  // ... rest of context
```

Wait — `confirmedProjectPaths` changes at runtime, so it should be a getter like `currentTaskId`. Update the `ToolContext` type:

```typescript
confirmedProjectPaths?: () => string[];
```

**Step 4: Commit**

```bash
git add app/orchestrator/worker.ts app/agent-tools/index.ts
git commit -m "feat(worker): handle WORKER_UPDATE_PROJECTS and expose confirmed paths to tools"
```

---

### Task 9: Update Project Guard for Multi-Project Support

**Files:**
- Modify: `app/agent-tools/project-guard.ts`
- Modify: `__tests__/agent-tools/project-guard.test.ts`

**Step 1: Write failing tests for multi-project guard**

Add to `__tests__/agent-tools/project-guard.test.ts`:

```typescript
describe('assertProjectConfirmed with confirmedPaths', () => {
  const workspaceDir = '/home/user/milo-workspace';

  it('should allow when projectPath matches one of confirmedPaths', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/my-app',
      workspaceDir,
      'PROJECTS',
      ['/home/user/milo-workspace/PROJECTS/my-app', '/home/user/milo-workspace/PROJECTS/api-backend'],
    )).not.toThrow();
  });

  it('should allow when projectPath is subfolder of a confirmedPath', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/my-app/src',
      workspaceDir,
      'PROJECTS',
      ['/home/user/milo-workspace/PROJECTS/my-app'],
    )).not.toThrow();
  });

  it('should throw when projectPath is not in confirmedPaths', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/secret-project',
      workspaceDir,
      'PROJECTS',
      ['/home/user/milo-workspace/PROJECTS/my-app'],
    )).toThrow('No project has been confirmed');
  });

  it('should still throw for PROJECTS root even with confirmedPaths', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS',
      workspaceDir,
      'PROJECTS',
      ['/home/user/milo-workspace/PROJECTS/my-app'],
    )).toThrow('No project has been confirmed');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/project-guard.test.ts -v`
Expected: FAIL — `assertProjectConfirmed` doesn't accept a 4th parameter.

**Step 3: Update project guard**

In `app/agent-tools/project-guard.ts`, update the function signature and logic:

```typescript
export function assertProjectConfirmed(
  projectPath: string,
  workspaceDir: string,
  projectsDir = 'PROJECTS',
  confirmedPaths?: string[],
): void {
  const projectsRoot = resolve(workspaceDir, projectsDir);
  const normalizedPath = resolve(projectPath);
  const rel = relative(projectsRoot, normalizedPath);

  // Must be under PROJECTS/ and not the root itself
  if (!rel || rel === '.' || rel.startsWith('..')) {
    throw new Error(
      'No project has been confirmed for this session. ' +
      'Before using coding tools, you must select a project. ' +
      'Read the project-setup skill at SKILLS/project-setup.md ' +
      'and follow its instructions to confirm a project with the user, ' +
      'then call set_project.',
    );
  }

  // If confirmedPaths provided, validate against them
  if (confirmedPaths && confirmedPaths.length > 0) {
    const isAllowed = confirmedPaths.some((cp) => {
      const normalizedConfirmed = resolve(cp);
      return normalizedPath === normalizedConfirmed || normalizedPath.startsWith(normalizedConfirmed + '/');
    });
    if (!isAllowed) {
      throw new Error(
        'No project has been confirmed for this session. ' +
        'Before using coding tools, you must select a project. ' +
        'Read the project-setup skill at SKILLS/project-setup.md ' +
        'and follow its instructions to confirm a project with the user, ' +
        'then call set_project.',
      );
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/project-guard.test.ts -v`
Expected: PASS

**Step 5: Run all existing project-guard tests to verify no regressions**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/project-guard.test.ts -v`
Expected: All existing tests still PASS (the 4th parameter is optional).

**Step 6: Commit**

```bash
git add app/agent-tools/project-guard.ts __tests__/agent-tools/project-guard.test.ts
git commit -m "feat(guard): support multi-project validation in project guard"
```

---

### Task 10: Add "Set Project" Button to Web Chat UI

**Files:**
- Modify: `/Users/byron/dev/milo-bot/web/components/chat/ChatWindow.tsx`

**Step 1: Add the FolderOpen icon import**

In the icon import line (line 4), add `FolderOpen`:

```typescript
import { Ban, LogOut, Activity, Brain, ChevronDown, Trash2, Minimize2, Lock, FolderOpen } from 'lucide-react';
```

**Step 2: Add the button**

After the "Get Status" button (after line 180), add:

```tsx
<Button
  variant="outline"
  size="sm"
  disabled={isSending || isAgentOffline}
  onClick={() => onAction('SET_PROJECT', 'Set Project')}
>
  <FolderOpen className="mr-1 h-3 w-3" />
  Set Project
</Button>
```

**Step 3: Commit**

```bash
git add /Users/byron/dev/milo-bot/web/components/chat/ChatWindow.tsx
git commit -m "feat(web): add Set Project button to session chat UI"
```

---

### Task 11: Integration Testing and Verification

**Step 1: Run all agent tests**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm test`
Expected: All tests PASS.

**Step 2: Run type checking**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No type errors.

**Step 3: Run lint**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm lint`
Expected: No lint errors.

**Step 4: Build**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm build`
Expected: Successful build.

**Step 5: Commit any fixes**

If any of the above steps require fixes, make the fixes and commit.

**Step 6: Final commit with all changes verified**

```bash
git add -A
git commit -m "chore: verify list-projects and set-project features pass all checks"
```
