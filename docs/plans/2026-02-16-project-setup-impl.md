# Project Setup & Confirmation Flow — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a skill-driven project confirmation flow that runs before coding tools are invoked, ensuring the agent always works in the correct project directory.

**Architecture:** A user-editable skill (`SKILLS/project-setup.md`) defines the conversational flow. A new `set_project` tool handles project selection/creation and updates worker state. Coding tools have a hard guard that blocks execution until a project is confirmed. The session tracks the confirmed project and persists it to the DB.

**Tech Stack:** TypeScript, pi-agent-core AgentTool, better-sqlite3, Node.js child_process (for git init)

---

### Task 1: Add `WORKER_PROJECT_SET` IPC Message Type

**Files:**
- Modify: `app/orchestrator/ipc-types.ts`

**Step 1: Add the new message interface and update the union type**

In `app/orchestrator/ipc-types.ts`, add after the `WorkerQuestionMessage` interface (line ~152):

```typescript
export interface WorkerProjectSetMessage {
  type: 'WORKER_PROJECT_SET';
  sessionId: string;
  projectName: string;
  projectPath: string;
  isNew: boolean;
}
```

Update the `WorkerToOrchestrator` union type to include `WorkerProjectSetMessage`:

```typescript
export type WorkerToOrchestrator =
  | WorkerReadyMessage
  | WorkerTaskStartedMessage
  | WorkerTaskDoneMessage
  | WorkerTaskCancelledMessage
  | WorkerErrorMessage
  | WorkerProgressMessage
  | WorkerStreamTextMessage
  | WorkerToolStartMessage
  | WorkerToolEndMessage
  | WorkerQuestionMessage
  | WorkerProjectSetMessage;
```

**Step 2: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS (no errors related to ipc-types)

**Step 3: Commit**

```bash
git add app/orchestrator/ipc-types.ts
git commit -m "feat: add WORKER_PROJECT_SET IPC message type"
```

---

### Task 2: Add `confirmed_project` Column to Sessions DB

**Files:**
- Modify: `app/db/schema.ts`
- Modify: `app/db/sessions-db.ts`

**Step 1: Add migration for `confirmed_project` column**

In `app/db/schema.ts`, add to the `MIGRATIONS` array:

```typescript
`ALTER TABLE sessions ADD COLUMN confirmed_project TEXT`,
```

**Step 2: Add `confirmed_project` to `SessionRecord` interface and create update function**

In `app/db/sessions-db.ts`, add `confirmed_project` to the `SessionRecord` interface:

```typescript
export interface SessionRecord {
  session_id: string;
  session_name?: string;
  session_type: string;
  status: string;
  worker_pid?: number;
  worker_state?: string;
  current_task_id?: string;
  confirmed_project?: string;   // <-- new
  created_at: string;
  updated_at: string;
  closed_at?: string;
  error?: string;
}
```

Add a new function:

```typescript
export function updateConfirmedProject(db: Database.Database, sessionId: string, projectName: string): void {
  db.prepare(`
    UPDATE sessions SET confirmed_project = ?, updated_at = datetime('now') WHERE session_id = ?
  `).run(projectName, sessionId);
}

export function getConfirmedProject(db: Database.Database, sessionId: string): string | undefined {
  const row = db.prepare(`SELECT confirmed_project FROM sessions WHERE session_id = ?`).get(sessionId) as { confirmed_project?: string } | undefined;
  return row?.confirmed_project ?? undefined;
}
```

**Step 3: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add app/db/schema.ts app/db/sessions-db.ts
git commit -m "feat: add confirmed_project column to sessions DB"
```

---

### Task 3: Create the Project Guard (`app/agent-tools/project-guard.ts`)

**Files:**
- Create: `app/agent-tools/project-guard.ts`

**Step 1: Write the guard function**

Create `app/agent-tools/project-guard.ts`:

```typescript
/**
 * Project Guard
 *
 * Blocks coding tool execution if no specific project has been confirmed
 * for the session. The projectPath must point to a subfolder under PROJECTS/,
 * not the PROJECTS root itself.
 */

import { resolve, relative } from 'path';

/**
 * Assert that projectPath points to a specific project subfolder under PROJECTS/.
 * Throws if projectPath is the PROJECTS root or outside PROJECTS entirely.
 *
 * @param projectPath - The current project path (from tool context or override param)
 * @param workspaceDir - The workspace root directory
 * @param projectsDir - The projects directory name (default: 'PROJECTS')
 */
export function assertProjectConfirmed(
  projectPath: string,
  workspaceDir: string,
  projectsDir = 'PROJECTS',
): void {
  const projectsRoot = resolve(workspaceDir, projectsDir);
  const normalizedPath = resolve(projectPath);
  const rel = relative(projectsRoot, normalizedPath);

  if (!rel || rel === '.' || rel.startsWith('..')) {
    throw new Error(
      'No project has been confirmed for this session. ' +
      'Before using coding tools, you must select a project. ' +
      'Read the project-setup skill at SKILLS/project-setup.md ' +
      'and follow its instructions to confirm a project with the user, ' +
      'then call set_project.',
    );
  }
}
```

**Step 2: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/agent-tools/project-guard.ts
git commit -m "feat: add project guard for coding tools"
```

---

### Task 4: Create the `set_project` Tool (`app/agent-tools/project-tool.ts`)

**Files:**
- Create: `app/agent-tools/project-tool.ts`
- Modify: `app/agent-tools/index.ts`

**Step 1: Write the `set_project` tool**

Create `app/agent-tools/project-tool.ts`:

```typescript
/**
 * set_project Tool
 *
 * Confirms or creates a project for the current session.
 * Updates the worker's projectPath and notifies the orchestrator.
 */

import { resolve, join } from 'path';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from './index.js';

const SetProjectParams = Type.Object({
  projectName: Type.String({
    description: 'Name of the project folder inside PROJECTS/.',
  }),
  isNew: Type.Boolean({
    description: 'Set to true to create a new project. Set to false to use an existing project.',
  }),
});

/**
 * List existing project folder names under the PROJECTS directory.
 */
function listProjects(projectsRoot: string): string[] {
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function createSetProjectTool(ctx: ToolContext, callbacks: {
  onProjectSet: (projectName: string, projectPath: string, isNew: boolean) => void;
}): AgentTool<typeof SetProjectParams> {
  return {
    name: 'set_project',
    label: 'Set Project',
    description:
      'Confirm or create a project for this session. Must be called before using any coding tool (claude_code, gemini_cli, codex_cli). ' +
      'Use isNew=false to select an existing project, or isNew=true to create a new one.',
    parameters: SetProjectParams,
    execute: async (_toolCallId, params) => {
      const projectsRoot = resolve(ctx.workspaceDir, 'PROJECTS');
      const projectPath = join(projectsRoot, params.projectName);
      const existingProjects = listProjects(projectsRoot);

      if (params.isNew) {
        // Creating a new project
        if (existsSync(projectPath)) {
          return {
            content: [{
              type: 'text',
              text: `A project named "${params.projectName}" already exists. ` +
                `To work on the existing project, call set_project with isNew: false. ` +
                `To create a new project, choose a different name.\n\n` +
                `Existing projects: ${existingProjects.join(', ') || '(none)'}`,
            }],
            details: { error: 'project_exists' },
          };
        }

        // Create project directory
        mkdirSync(projectPath, { recursive: true });

        // Initialize git repo
        try {
          execSync('git init', { cwd: projectPath, stdio: 'pipe' });
        } catch (err) {
          // Non-fatal — project still usable without git
        }

        // Copy DEFAULT-CLAUDE.md from templates if it exists
        const templatesDir = resolve(ctx.workspaceDir, 'templates');
        const defaultClaudeMd = join(templatesDir, 'DEFAULT-CLAUDE.md');
        if (existsSync(defaultClaudeMd)) {
          copyFileSync(defaultClaudeMd, join(projectPath, 'CLAUDE.md'));
        }

        callbacks.onProjectSet(params.projectName, projectPath, true);

        return {
          content: [{
            type: 'text',
            text: `New project "${params.projectName}" created and set as active project. ` +
              `Initialized git repo and copied CLAUDE.md template. ` +
              `All tools now operate in: ${projectPath}`,
          }],
          details: { projectName: params.projectName, projectPath, isNew: true },
        };
      } else {
        // Using an existing project
        if (!existsSync(projectPath)) {
          return {
            content: [{
              type: 'text',
              text: `Project "${params.projectName}" not found in PROJECTS/. ` +
                `Available projects: ${existingProjects.join(', ') || '(none)'}`,
            }],
            details: { error: 'project_not_found' },
          };
        }

        callbacks.onProjectSet(params.projectName, projectPath, false);

        return {
          content: [{
            type: 'text',
            text: `Project set to "${params.projectName}" (existing project). ` +
              `All coding tools will now operate in: ${projectPath}`,
          }],
          details: { projectName: params.projectName, projectPath, isNew: false },
        };
      }
    },
  };
}
```

**Step 2: Register `set_project` in tool loader**

In `app/agent-tools/index.ts`, add the import:

```typescript
import { createSetProjectTool } from './project-tool.js';
```

The `set_project` tool needs a `callbacks.onProjectSet` that updates worker state and sends IPC. This callback will be wired in Task 6 (worker.ts changes). For now, register the tool in `loadTools` with a placeholder.

Add after the existing tool creation lines (around line 46-48), before the switch statement:

```typescript
const setProjectTool = createSetProjectTool(ctx, {
  onProjectSet: (projectName, newProjectPath, isNew) => {
    // Will be replaced with real callback in Task 6
  },
});
```

Update each case in the switch to include `setProjectTool`:

- `'full'`: `return [...coreTools, setProjectTool, ...cliTools, uiTools[0], createBrowserTool()];`
- `'minimal'`: `return [...coreTools, setProjectTool, ...uiTools];`
- default array case: add `setProjectTool` to `all`

Do NOT include `setProjectTool` in the `'chat'` toolset (chat sessions don't use coding tools).

**Step 3: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add app/agent-tools/project-tool.ts app/agent-tools/index.ts
git commit -m "feat: add set_project tool for project confirmation"
```

---

### Task 5: Add Guards to Coding Tools

**Files:**
- Modify: `app/agent-tools/claude-code-oauth-tool.ts`
- Modify: `app/agent-tools/cli-agent-tools.ts`

**Step 1: Add guard to Claude Code OAuth tool**

In `app/agent-tools/claude-code-oauth-tool.ts`, add import at top:

```typescript
import { assertProjectConfirmed } from './project-guard.js';
```

In the `execute` function (line ~119), right after `const cwd = params.workingDirectory ?? ctx.projectPath;` (line ~121), add:

```typescript
assertProjectConfirmed(cwd, ctx.workspaceDir);
```

**Step 2: Add guard to Claude Code CLI (SDK) tool**

In `app/agent-tools/cli-agent-tools.ts`, add import at top:

```typescript
import { assertProjectConfirmed } from './project-guard.js';
```

In the `claude_code_cli` execute function (line ~99), right after `const cwd = params.workingDirectory ?? ctx.projectPath;` (line ~102), add:

```typescript
assertProjectConfirmed(cwd, ctx.workspaceDir);
```

**Step 3: Add guard to gemini_cli and codex_cli stubs**

In the same file (`cli-agent-tools.ts`), add the guard at the top of each stub's execute function:

For `gemini_cli` (line ~188):
```typescript
execute: async (_toolCallId, _params) => {
  assertProjectConfirmed(ctx.projectPath, ctx.workspaceDir);
  throw new Error('Gemini CLI integration is not yet implemented.');
},
```

For `codex_cli` (line ~196):
```typescript
execute: async (_toolCallId, _params) => {
  assertProjectConfirmed(ctx.projectPath, ctx.workspaceDir);
  throw new Error('Codex CLI integration is not yet implemented.');
},
```

**Step 4: Add `workspaceDir` to `ToolContext` usage in OAuth tool**

The OAuth tool receives `ctx: ToolContext` which already has `workspaceDir`, so no interface changes needed.

**Step 5: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add app/agent-tools/claude-code-oauth-tool.ts app/agent-tools/cli-agent-tools.ts
git commit -m "feat: add project guard to coding tools"
```

---

### Task 6: Wire `set_project` Callbacks in Worker

**Files:**
- Modify: `app/orchestrator/worker.ts`
- Modify: `app/agent-tools/index.ts`

**Step 1: Add project state tracking to worker**

In `app/orchestrator/worker.ts`, add after the existing state variables (around line ~36):

```typescript
let projectChanged = false;
```

**Step 2: Update `ToolContext` to accept `onProjectSet` callback**

In `app/agent-tools/index.ts`, add to the `ToolContext` interface:

```typescript
export interface ToolContext {
  projectPath: string;
  workspaceDir: string;
  sessionId: string;
  sessionName: string;
  currentTaskId: () => string | null;
  preferAPIKeyClaude?: boolean;
  sendNotification: (message: string) => void;
  askUser: (opts: {
    toolCallId: string;
    question: string;
    options?: string[];
  }) => Promise<string>;
  sendIpcEvent?: (event: {
    type: 'tool_start' | 'tool_end' | 'stream_text' | 'progress';
    toolName?: string;
    toolCallId?: string;
    delta?: string;
    message?: string;
    success?: boolean;
    summary?: string;
  }) => void;
  onProjectSet?: (projectName: string, projectPath: string, isNew: boolean) => void;  // <-- new
}
```

Update the `loadTools` function to wire the real callback:

```typescript
const setProjectTool = createSetProjectTool(ctx, {
  onProjectSet: (projectName, newProjectPath, isNew) => {
    ctx.onProjectSet?.(projectName, newProjectPath, isNew);
  },
});
```

**Step 3: Wire the callback in worker's `createAgent` function**

In `app/orchestrator/worker.ts`, in the `createAgent` function where the tool context is built (around line ~163), add the `onProjectSet` callback:

```typescript
onProjectSet: (projectName: string, newProjectPath: string, isNew: boolean) => {
  projectPath = newProjectPath;
  projectChanged = true;
  send({
    type: 'WORKER_PROJECT_SET',
    sessionId,
    projectName,
    projectPath: newProjectPath,
    isNew,
  });
},
```

**Step 4: Add `projectChanged` to the agent recreation check**

In `app/orchestrator/worker.ts`, in `handleTask()` (around line ~326), update the `needsRecreate` condition:

```typescript
const needsRecreate = !agent || personaChanged || modelChanged || projectChanged;
```

And after the `if (needsRecreate)` block completes (around line ~356), reset the flag:

```typescript
if (needsRecreate) {
  // ... existing persona/agent creation code ...

  // Reset project change flag
  projectChanged = false;
}
```

**Step 5: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add app/orchestrator/worker.ts app/agent-tools/index.ts
git commit -m "feat: wire set_project IPC in worker"
```

---

### Task 7: Handle `WORKER_PROJECT_SET` in Orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`
- Modify: `app/orchestrator/session-actor.ts`

**Step 1: Handle the new IPC event in orchestrator**

In `app/orchestrator/orchestrator.ts`, import the new DB function:

```typescript
import {
  upsertSession,
  updateSessionStatus,
  updateWorkerState,
  updateConfirmedProject,  // <-- new
  getActiveSessions,
  getConfirmedProject,     // <-- new
  insertSessionMessage,
} from '../db/sessions-db.js';
```

In the `handleWorkerEvent` method (line ~461), add a new case before the closing `}` of the switch:

```typescript
case 'WORKER_PROJECT_SET': {
  const actor = this.actorManager.get(sessionId);
  if (actor) {
    actor.projectPath = event.projectPath;
  }
  updateConfirmedProject(this.db, sessionId, event.projectName);
  const verb = event.isNew ? 'Created and set' : 'Set';
  this.logger.info(`${verb} project "${event.projectName}" for session ${sessionId}`);
  break;
}
```

**Step 2: Change default `projectPath` to PROJECTS directory**

In `app/orchestrator/orchestrator.ts`, update line ~386:

```typescript
// Old:
const projectPath = this.config.workspace.baseDir;

// New:
const projectPath = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
```

**Step 3: Ensure PROJECTS directory exists on startup**

In the `start()` method (around line ~90), after `this.db = getDb(...)` (line ~97), add:

```typescript
// Ensure PROJECTS directory exists
import { mkdirSync } from 'fs';
```

Wait — `mkdirSync` is not imported in orchestrator.ts. Check what's imported.

Actually, `existsSync` and `unlinkSync` are already imported from `fs` (line 14). Add `mkdirSync`:

```typescript
import { existsSync, unlinkSync, mkdirSync } from 'fs';
```

Then after the DB open (line ~98), add:

```typescript
const projectsDir = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
mkdirSync(projectsDir, { recursive: true });
```

**Step 4: Restore confirmed project on session recovery**

In the `recoverOrphanedSessions` method, and also in `routeMessage` where sessions are created, check for a stored `confirmed_project`. Update the `routeMessage` section (around line ~385-393):

```typescript
// Determine project path — restore confirmed project if available
let projectPath = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
const confirmedProject = getConfirmedProject(this.db, message.sessionId);
if (confirmedProject) {
  const restored = join(projectPath, confirmedProject);
  if (existsSync(restored)) {
    projectPath = restored;
  }
}
```

Also update the dummy context for `getAvailableToolNames` (line ~855):

```typescript
projectPath: join(this.config.workspace.baseDir, this.config.workspace.projectsDir),
```

**Step 5: Verify types compile**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add app/orchestrator/orchestrator.ts app/db/sessions-db.ts
git commit -m "feat: handle WORKER_PROJECT_SET in orchestrator, change default projectPath"
```

---

### Task 8: Create the `project-setup` Skill File

**Files:**
- Create: `SKILLS/project-setup.md` (in workspace — but for distribution/testing, create at a known path)

Since skills live in the user's workspace (`~/milo-workspace/SKILLS/`), we need a default skill that ships with the agent. Create it as a template that gets copied during `milo init`.

**Step 1: Create the default skill file in the agent's templates directory**

Create `app/templates/SKILLS/project-setup.md`:

```markdown
---
description: Guides project selection and creation before using coding tools. Follow this skill before calling claude_code, gemini_cli, or codex_cli.
---

# Project Setup

## When to Use

Before calling any coding tool (`claude_code`, `claude_code_cli`, `gemini_cli`, `codex_cli`), if no project has been set for this session, you MUST follow this skill to confirm a project with the user.

## How to Detect

If you call a coding tool and receive the error "No project has been confirmed for this session", follow the steps below.

You should also proactively follow these steps when you determine the user's request will require a coding tool, before actually calling the tool.

## Step 1: Identify the Target Project

Use the `list_files` tool to list directories in the PROJECTS folder. These are the available projects.

Try to determine the target project:
1. **Session name match**: If the session name matches a project folder name, suggest that project.
2. **Message inference**: If the user's message mentions a project name or describes a project that clearly matches one in the list, suggest that project.
3. **Ask the user**: If no clear match, list all projects and ask.

## Step 2: Confirm with the User

Present a numbered confirmation prompt:

```
Before I start coding, let me confirm which project to work on.

I found these projects in your workspace:
1. <project-a> (existing project)
2. <project-b> (existing project)
3. <project-c> (existing project)

Based on your request, I think you want to work on **<best-match>**.

Please confirm:
1. Work on **<best-match>** (existing project)
2. Start a new project
3. Work on a different project (enter project number or name)
```

If there are no existing projects, skip straight to asking if they want to create a new project.

## Step 3: Handle the Response

### If the user confirms an existing project:
Call `set_project` with `projectName: "<name>"` and `isNew: false`.

### If the user wants a new project:
Ask for the project name. Then call `set_project` with `projectName: "<name>"` and `isNew: true`.

If `set_project` returns an error saying the project already exists, inform the user:

```
A project named "<name>" already exists. Did you mean to:
1. Work on the existing "<name>" project
2. Create a new project with a different name
```

### If the user picks a different project (option 3):
They may respond with a project number from the list or type a project name. Resolve their choice and call `set_project` accordingly.

## Step 4: Proceed

After `set_project` succeeds, proceed with the original coding task.

## Switching Projects Mid-Session

If during the session the user indicates they want to work on a different project, suggest:

```
It sounds like you want to switch to project "<name>". You can:
1. Switch to "<name>" now in this session
2. Start a new session for "<name>" (recommended for clean context)
```

If they choose to switch, call `set_project` with the new project name.
```

**Step 2: Wire skill into workspace initialization**

Check if `milo init` copies skills to the workspace. If the SKILLS directory is empty after init, the skill file should be copied as a default. This will be handled by adding the file to the init command's workspace setup.

For now, create the skill file in a location that can be referenced. The init command (`app/commands/init.ts`) should copy `app/templates/SKILLS/` to `~/milo-workspace/SKILLS/` if the SKILLS directory is empty.

Look at `app/commands/init.ts` for the workspace setup logic and add a step to copy default skills. Add after existing directory creation:

```typescript
// Copy default skills if SKILLS dir is empty
const defaultSkillsDir = join(__dirname, '..', 'templates', 'SKILLS');
const workspaceSkillsDir = join(workspaceDir, 'SKILLS');
if (existsSync(defaultSkillsDir)) {
  const existingSkills = existsSync(workspaceSkillsDir) ? readdirSync(workspaceSkillsDir) : [];
  if (existingSkills.length === 0) {
    mkdirSync(workspaceSkillsDir, { recursive: true });
    const defaultSkills = readdirSync(defaultSkillsDir);
    for (const skill of defaultSkills) {
      copyFileSync(join(defaultSkillsDir, skill), join(workspaceSkillsDir, skill));
    }
  }
}
```

**Step 3: Verify the skill file is well-formed**

Read the skill file back and verify the YAML front-matter parses correctly and `discoverSkills()` would pick it up.

**Step 4: Commit**

```bash
git add app/templates/SKILLS/project-setup.md
git commit -m "feat: add default project-setup skill"
```

---

### Task 9: Ensure PROJECTS Directory in Init Command

**Files:**
- Modify: `app/commands/init.ts`

**Step 1: Verify init creates PROJECTS directory**

Read `app/commands/init.ts` and find where workspace directories are created. Ensure `PROJECTS` is included alongside `SESSIONS`, `SKILLS`, etc. If it's missing, add it.

Also ensure the `templates` directory is created (for `DEFAULT-CLAUDE.md`).

**Step 2: Create a `DEFAULT-CLAUDE.md` template file**

Create `app/templates/DEFAULT-CLAUDE.md`:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code when working on this project.

## Project Overview

<!-- Describe your project here -->

## Commands

```bash
# Add your development commands here
```

## Architecture

<!-- Describe your project's architecture -->

## Critical Rules

- Investigate before acting — read files before making changes
- Keep changes simple and focused
- Ask clarifying questions for ambiguous tasks
```

Ensure init copies this to `~/milo-workspace/templates/DEFAULT-CLAUDE.md` if it doesn't already exist.

**Step 3: Commit**

```bash
git add app/commands/init.ts app/templates/DEFAULT-CLAUDE.md
git commit -m "feat: ensure PROJECTS dir and DEFAULT-CLAUDE.md in workspace init"
```

---

### Task 10: Integration Testing

**Files:**
- Test manually or write: `__tests__/agent-tools/project-guard.test.ts`
- Test manually or write: `__tests__/agent-tools/project-tool.test.ts`

**Step 1: Write project guard tests**

Create `__tests__/agent-tools/project-guard.test.ts`:

```typescript
import { assertProjectConfirmed } from '../../app/agent-tools/project-guard.js';

describe('assertProjectConfirmed', () => {
  const workspaceDir = '/home/user/milo-workspace';

  it('should throw when projectPath is PROJECTS root', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS',
      workspaceDir,
    )).toThrow('No project has been confirmed');
  });

  it('should throw when projectPath is PROJECTS root with trailing slash', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/',
      workspaceDir,
    )).toThrow('No project has been confirmed');
  });

  it('should allow when projectPath is a project subfolder', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/my-app',
      workspaceDir,
    )).not.toThrow();
  });

  it('should allow when project is named PROJECTS', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/PROJECTS',
      workspaceDir,
    )).not.toThrow();
  });

  it('should throw when projectPath is outside PROJECTS', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace',
      workspaceDir,
    )).toThrow('No project has been confirmed');
  });

  it('should allow nested project paths', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/my-app/src',
      workspaceDir,
    )).not.toThrow();
  });
});
```

**Step 2: Run the tests**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/project-guard.test.ts`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add __tests__/agent-tools/project-guard.test.ts
git commit -m "test: add project guard unit tests"
```

**Step 4: Run full typecheck and test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

**Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address any integration issues from project setup feature"
```
