# List Projects & Set Project Features — Design

**Date:** 2026-02-21
**Status:** Approved

## Overview

Two features for project management from the web chat interface:

1. **List Projects** — Natural language command ("list projects", "what projects are there?") returns the PROJECTS/ folder listing. Works from any chat context (with or without a session).
2. **Set Project** — UI button in session chat sends a form with checkboxes for each project folder. User selects one or more projects, which become the confirmed projects for that session. Multi-project support — all selected projects are accessible to worker tools.

## Feature 1: List Projects Command

### Approach

Inline orchestrator handling (no worker/AI needed), same pattern as `/models` and `/status`.

### Changes

**`app/shared/types.ts`** — Add `'list_projects'` to `IntentType` union.

**`app/orchestrator/session-types.ts`** — Add `'LIST_PROJECTS'` to `WorkItemType`.

**`app/intent/patterns.ts`** — New `matchListProjectsPatterns(content)` function with regex patterns:
- `^(list|show|get)\s+(the\s+)?projects?\s*(list|folders?)?$`
- `^what\s+projects?\s+(are\s+there|do\s+(i|we)\s+have|exist).*$`
- `^projects?\s*$` (bare "projects" command)
- `/projects` slash command

**`app/intent/parser.ts`** — Check `matchListProjectsPatterns()` before open_session patterns. Return `{ type: 'list_projects', confidence: 0.95 }`. Add `list_projects` to AI fallback system prompt.

**`app/orchestrator/orchestrator.ts`**:
- `deriveWorkItemType()`: detect `uiAction === 'LIST_PROJECTS'` and text patterns (`/projects`, `list projects`, etc.)
- `handleMessage()`: handle `LIST_PROJECTS` inline (before actor creation):
  - Read PROJECTS/ directory (readdirSync, filter directories, skip dot-prefixed)
  - Format as text list with count
  - `publishEvent()` + `enqueueOutbox()` to send response
  - Return early (no worker needed)

### Response Format

```
Projects (3):
- my-app
- api-backend
- cli-tool
```

Or if empty: `No projects found in PROJECTS/. Create one by starting a coding session.`

## Feature 2: Set Project UI Button + Form

### Approach

PubNub ui_action pattern. Orchestrator handles the form lifecycle inline (not via worker).

### Web Changes

**`web/components/chat/ChatWindow.tsx`** — Add "Set Project" button with `FolderOpen` icon in the action buttons row. Calls `onAction('SET_PROJECT', 'Set Project')`. Disabled when agent is offline or sending.

No other web changes needed — existing `handleAction()`, `sendMessage()`, form rendering, and form submission all work as-is.

### Agent Changes

**`app/orchestrator/session-types.ts`** — Add `'SET_PROJECT'` to `WorkItemType`.

**`app/orchestrator/orchestrator.ts`**:

`deriveWorkItemType()`: detect `uiAction === 'SET_PROJECT'`.

`handleMessage()`: handle `SET_PROJECT` inline:
1. Read PROJECTS/ folder to get directory list
2. Build `FormDefinition`:
   - `formId`: random UUID
   - `title`: "Select Projects"
   - `description`: "Choose which projects this session should have access to."
   - `critical`: false
   - `status`: "pending"
   - `fields`: one `checkbox` field per project folder (`name` = sanitized folder name, `label` = folder name, `defaultValue` = true if already confirmed for this session)
   - `submitLabel`: "Set Projects"
3. Track in `pendingForms` with a sentinel `taskId` (e.g., `"orchestrator:set_project"`) so the form response handler knows to route it to the orchestrator instead of a worker
4. Publish via PubNub `form_request` + persist via outbox (same pattern as `WORKER_FORM_REQUEST`)

Form response handling (in `handlePubNubControl`):
1. Detect orchestrator-owned forms by `taskId` prefix `"orchestrator:"`
2. Extract checked project names from `values` (keys where value is `true`)
3. If cancelled, send "Project selection cancelled" message, return
4. Update session actor's `projectPath` to first selected project
5. Store all confirmed projects in SQLite via new `updateConfirmedProjects(db, sessionId, projectNames[])`
6. Send `WORKER_UPDATE_PROJECTS` IPC message to running worker with the list of project paths
7. Send confirmation message: "Projects set for this session: project-a, project-b"

**`app/orchestrator/ipc-types.ts`** — New IPC message:
```typescript
interface WorkerUpdateProjectsMessage {
  type: 'WORKER_UPDATE_PROJECTS';
  sessionId: string;
  projectPaths: string[];  // Full paths
  primaryProjectPath: string;  // First selected, used as cwd
}
```

Add to `OrchestratorToWorker` union.

**`app/orchestrator/worker.ts`** — Handle `WORKER_UPDATE_PROJECTS`: update the tool context's `projectPath` and store the full list for the project guard.

**`app/agent-tools/project-guard.ts`** — `assertProjectConfirmed()` accepts an optional `confirmedPaths: string[]` parameter. If provided, validates that `projectPath` is under any of them (not just a single path).

**`app/db/sessions-db.ts`** — New `updateConfirmedProjects(db, sessionId, projectNames: string[])` that stores a JSON array. Update `getConfirmedProject()` → `getConfirmedProjects()` returning `string[]`. Keep backward compat (single string → array of one).

### Form Example

For a workspace with projects `my-app`, `api-backend`, `cli-tool`:

```json
{
  "formId": "uuid-here",
  "title": "Select Projects",
  "description": "Choose which projects this session should have access to.",
  "critical": false,
  "status": "pending",
  "fields": [
    { "type": "checkbox", "name": "my_app", "label": "my-app", "required": false, "defaultValue": false },
    { "type": "checkbox", "name": "api_backend", "label": "api-backend", "required": false, "defaultValue": false },
    { "type": "checkbox", "name": "cli_tool", "label": "cli-tool", "required": false, "defaultValue": false }
  ],
  "submitLabel": "Set Projects"
}
```

### Multi-Project Worker Context

When multiple projects are set:
- `primaryProjectPath` = first selected project (used as default cwd for tools)
- All selected paths are available to the project guard
- The worker's tool context exposes `confirmedProjectPaths: string[]` so tools can operate across projects

## Edge Cases

- **No projects exist**: SET_PROJECT returns a text message "No projects found" instead of an empty form.
- **Form field name sanitization**: Folder names with hyphens become underscores in field names (e.g., `my-app` → `my_app`). A mapping is maintained to reverse this when processing the response.
- **No projects selected**: If user submits with all unchecked, send "No projects selected. Tools requiring a project will be blocked until you set one."
- **Worker not yet spawned**: If SET_PROJECT arrives before a worker exists for the session, store the confirmed projects in SQLite. When the worker is later spawned, it loads them from the DB (existing pattern with `getConfirmedProject`).
