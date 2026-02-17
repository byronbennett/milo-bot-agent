# Project Setup & Confirmation Flow

**Date:** 2026-02-16
**Status:** Approved

## Problem

Currently, the worker's `projectPath` is set to `workspace.baseDir` (e.g., `~/milo-workspace`) for all sessions. When the agent delegates work to a coding tool (Claude Code, Gemini CLI, Codex CLI), it operates in this root directory rather than a specific project folder. There is no mechanism to confirm which project the user wants to work on before coding begins.

## Solution Overview

A skill-driven project confirmation flow that runs before any coding tool is invoked. The flow is defined in a user-editable skill file (`SKILLS/project-setup.md`) and enforced by a hard guard in the coding tools. A new `set_project` tool handles validation, project creation, and state updates.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger point | Once per session, changeable mid-session | User can switch projects but doesn't re-confirm every tool call |
| Project detection | Session name match → message inference → list and ask | Minimize user friction while staying accurate |
| Enforcement | System prompt skill + coding tool hard guard | Belt and suspenders — skill guides the agent, guard enforces |
| State tracking | Session-level variable, persisted to DB | Survives crashes, visible in web app |
| Project change handling | Recreate agent | Picks up new CLAUDE.md, consistent with persona/model change pattern |

## Components

### 1. Skill File: `SKILLS/project-setup.md`

User-editable skill defining the conversational flow. Discovered at agent creation, listed in system prompt. Agent reads the full file when it needs to confirm a project.

**Flow defined in the skill:**

1. **Trigger**: Before calling any coding tool, if no project is set for this session.

2. **Project resolution order**:
   - Check if the session name matches a folder in `PROJECTS/` — suggest that
   - Otherwise, infer from the user's message — suggest best match
   - If no match, list all projects and ask

3. **Confirmation prompt template**:
   ```
   Before I start coding, let me confirm which project to work on.

   I found these projects in your workspace:
   1. my-app (existing project)
   2. website (existing project)

   Based on your request, I think you want to work on **my-app**.

   Please confirm:
   1. Work on **my-app** (existing project)
   2. Start a new project
   3. Work on a different project (enter project number or name)
   ```

4. **New project flow**: If the user wants a new project, ask for the project name. Call `set_project` with `isNew: true`. If a project with that name already exists, the tool returns an error — relay to user:
   ```
   A project named "my-app" already exists. Did you mean to:
   1. Work on the existing "my-app" project
   2. Create a new project with a different name
   ```

5. **Project switch mid-session**: If the user mentions wanting to work on a different project:
   ```
   It sounds like you want to switch to project "other-app". You can:
   1. Switch to "other-app" now in this session
   2. Start a new session for "other-app" (recommended for clean context)
   ```
   If they choose to switch, call `set_project` again.

6. **After confirmation**: Call `set_project`, then proceed with the coding tool.

### 2. `set_project` Tool (`app/agent-tools/project-tool.ts`)

New agent tool registered in all tool sets that include coding tools.

**Parameters:**
```typescript
{
  projectName: string,   // Name of the project folder
  isNew: boolean         // true = create new project, false = use existing
}
```

**Behavior — existing project (`isNew: false`):**
- Check `PROJECTS/<projectName>` exists
- If not found → error: `"Project '<projectName>' not found. Available projects: [list]"`
- If found → update worker's `projectPath`, send `WORKER_PROJECT_SET` IPC
- Return: `"Project set to '<projectName>' (existing project). All coding tools will now operate in this directory."`

**Behavior — new project (`isNew: true`):**
- Check if `PROJECTS/<projectName>` already exists
- If exists → error: `"A project named '<projectName>' already exists. To work on the existing project, call set_project with isNew: false. To create a new project, choose a different name."`
- If doesn't exist:
  - Create `PROJECTS/<projectName>/`
  - Run `git init` in the new folder
  - Copy `TEMPLATES/DEFAULT-CLAUDE.md` → `PROJECTS/<projectName>/CLAUDE.md`
  - Update worker's `projectPath`, send `WORKER_PROJECT_SET` IPC
  - Return: `"New project '<projectName>' created and set as active project. Initialized git repo and copied CLAUDE.md template."`

**Side effects:**
- Updates module-level `projectPath` in worker
- Sets `projectChanged = true` flag so agent is recreated on next task (picks up new CLAUDE.md)

### 3. Coding Tool Guard (`app/agent-tools/project-guard.ts`)

Shared helper called at the top of each coding tool's `execute`.

**Logic:**
```typescript
function assertProjectConfirmed(projectPath: string, workspaceDir: string): void {
  const projectsDir = path.resolve(workspaceDir, 'PROJECTS');
  const normalizedPath = path.resolve(projectPath);
  const relative = path.relative(projectsDir, normalizedPath);

  // Block if path IS the PROJECTS root, or outside PROJECTS
  if (!relative || relative === '.' || relative.startsWith('..')) {
    throw new Error(
      'No project has been confirmed for this session. ' +
      'Before using coding tools, you must select a project. ' +
      'Read the project-setup skill at SKILLS/project-setup.md ' +
      'and follow its instructions to confirm a project with the user, ' +
      'then call set_project.'
    );
  }
}
```

Both `path.resolve()` calls normalize trailing slashes, `./`, etc. before comparison.

**Applied to:**
- `claude_code` (OAuth tool) — check `cwd` (`params.workingDirectory ?? ctx.projectPath`)
- `claude_code_cli` (SDK tool) — same check on `cwd`
- `gemini_cli` — check `ctx.projectPath`
- `codex_cli` — check `ctx.projectPath`

**Not applied to:**
- Core tools (file, bash, git, search) — agent needs these during the confirmation flow
- `set_project` itself
- `notify_user`, `browser`

### 4. Worker State Changes (`worker.ts`)

- New module-level flag: `projectChanged = false`
- `set_project` tool updates `projectPath` and sets `projectChanged = true`
- In `handleTask()`, add a check alongside the existing persona/model change detection:
  ```typescript
  const needsRecreate = !agent || personaChanged || modelChanged || projectChanged;
  ```
- When recreated due to project change, the new agent loads the new project's `CLAUDE.md`
- Reset `projectChanged = false` after recreation

### 5. Orchestrator & Session Actor Changes

**New IPC message type:**
```typescript
interface WorkerProjectSetMessage {
  type: 'WORKER_PROJECT_SET';
  sessionId: string;
  projectName: string;
  projectPath: string;  // full absolute path
  isNew: boolean;
}
```

**Orchestrator (`orchestrator.ts`):**
- Handle `WORKER_PROJECT_SET` in the worker event handler
- Update `actor.projectPath` to the new path
- Persist `confirmed_project` to sessions DB
- Enqueue outbox event for web app sync

**Session actor (`session-actor.ts`):**
- No structural changes — `actor.projectPath` is already mutable

**Session recovery:**
- When recovering sessions from a prior crash, if `confirmed_project` is set in DB, restore `actor.projectPath` to `PROJECTS/<confirmed_project>` instead of the default

### 6. Default `projectPath` Change

**Current** (`orchestrator.ts:386`):
```typescript
const projectPath = this.config.workspace.baseDir;
// ~/milo-workspace
```

**New:**
```typescript
const projectPath = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
// ~/milo-workspace/PROJECTS
```

On startup, ensure the `PROJECTS/` directory exists (create if missing).

### 7. DB Schema Change

Add `confirmed_project` column to the sessions table:
```sql
ALTER TABLE sessions ADD COLUMN confirmed_project TEXT;
```

Nullable — `NULL` means no project confirmed yet. Stores the project folder name (not full path).

## File Changes Summary

| File | Change |
|------|--------|
| `SKILLS/project-setup.md` | **New** — skill definition |
| `app/agent-tools/project-tool.ts` | **New** — `set_project` tool |
| `app/agent-tools/project-guard.ts` | **New** — shared guard function |
| `app/agent-tools/index.ts` | Register `set_project` tool, export guard |
| `app/agent-tools/cli-agent-tools.ts` | Add guard call in `claude_code_cli` execute |
| `app/agent-tools/claude-code-oauth-tool.ts` | Add guard call in `claude_code` execute |
| `app/orchestrator/worker.ts` | Add `projectChanged` flag, recreate agent on change |
| `app/orchestrator/ipc-types.ts` | Add `WORKER_PROJECT_SET` message type |
| `app/orchestrator/orchestrator.ts` | Handle new IPC, change default projectPath |
| `app/orchestrator/session-actor.ts` | No structural changes needed |
| `app/db/sessions-db.ts` | Add `confirmed_project` column |
