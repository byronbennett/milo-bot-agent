# MiloBot Agent — Flow of Control

## Overview

MiloBot is a local, polling-based autonomous agent. It runs as a daemon on your machine, periodically checking a remote server for pending user messages. When a message arrives, the agent parses the user's intent, spins up a Claude Code session to carry out the work, and reports results back through the server.

```
User (Web App) → Server → Agent (polling) → Claude Code → Agent → Server → User
```

---

## 1. Startup

**Entry:** `app/bin/milo.ts` → `app/cli.ts` → `app/commands/start.ts`

```
milo start
  │
  ├─ Load config (JSON + .env + keychain)
  ├─ Verify MILO_API_KEY is set
  ├─ Create MiloAgent instance
  │   ├─ WebAppAdapter (HTTP client to server)
  │   ├─ SessionManager (local markdown files)
  │   └─ HeartbeatScheduler (cron-based)
  ├─ agent.start()
  │   ├─ Discover tools (built-in + user tools)
  │   ├─ Send initial heartbeat
  │   └─ Start recurring heartbeat scheduler
  └─ Wait for SIGINT/SIGTERM → graceful shutdown
```

---

## 2. The Heartbeat Loop

The agent does not maintain a persistent connection. Instead, it polls the server on a cron interval (default: every 3 minutes).

**File:** `app/scheduler/heartbeat.ts`

```
Every N minutes:
  │
  ├─ POST /agent/heartbeat
  │   → Server responds: { agentId, pollIntervalMs }
  │
  ├─ GET /messages/pending
  │   → Server responds: [ PendingMessage, ... ]
  │
  ├─ For each message:
  │   └─ processMessage(message)
  │
  ├─ POST /messages/ack
  │   → Mark messages as handled
  │
  └─ processSession(session)
      → Monitor in-progress sessions
```

---

## 3. Message Processing

**File:** `app/agent.ts` → `processMessage()`

When a pending message arrives, the agent routes it through intent parsing:

```
processMessage(message)
  │
  ├─ parseIntentWithAI(message.content)
  │   │
  │   ├─ 1. Try regex pattern matching (fast, no API call)
  │   │     • "work on <project> to <task>"
  │   │     • "in <project>: <task>"
  │   │     • "<task> in <project>"
  │   │     • "start session for <task>"
  │   │     • "<verb> <task>"  (fix, add, build, etc.)
  │   │
  │   └─ 2. Fall back to Claude API (if patterns fail)
  │         → Returns JSON: { type, project, task }
  │
  └─ Route on intent.type:
      ├─ 'open_session'  → handleOpenSession()
      ├─ 'send_message'  → handleSendMessage()
      └─ 'unknown'       → Send clarification to user
```

**Files:** `app/intent/parser.ts`, `app/intent/patterns.ts`

---

## 4. Opening a Session

**File:** `app/agent.ts` → `handleOpenSession()`

This is the primary workflow — turning a user request into real work:

```
handleOpenSession(intent, message)
  │
  ├─ Check concurrent session limit (e.g., max 3)
  ├─ Resolve project alias → actual project path
  ├─ Generate session name (e.g., "fix-the-login-bug")
  │
  ├─ Enhance the prompt
  │   ├─ Match task type (fix, add, refactor, etc.)
  │   ├─ Apply template: "Fix the issue: {task}. Investigate..."
  │   └─ If no template: fall back to AI enhancement or minimal formatting
  │
  ├─ Create session file
  │   → SESSION/fix-the-login-bug.md (status: IN_PROGRESS)
  │
  ├─ Send message: "Starting session: fix-the-login-bug..."
  │
  ├─ Build task list
  │   → Task 1: notify_user — "Starting..."
  │   → Task 2: claude_code — Execute enhanced prompt (depends on Task 1)
  │   → Task 3: notify_user — "Completed" (depends on Task 2)
  │
  └─ Run tasks through orchestrator
```

**Files:** `app/prompt/enhancer.ts`, `app/session/manager.ts`

---

## 5. Task Orchestration

**File:** `app/task/orchestrator.ts`

The orchestrator runs a list of tasks in dependency order with retry support:

```
runTasks(tasks, context)
  │
  for each task:
  │ ├─ Check dependencies satisfied
  │ ├─ Execute task (with retry logic)
  │ ├─ Store result
  │ ├─ Update status: pending → running → completed/failed
  │ └─ On failure: retry or skip remaining (if stopOnFailure)
  │
  └─ Return OrchestratorResult
      { success, completedTasks, failedTasks, skippedTasks, results, errors }
```

### Available Task Types

| Type | Description |
|------|-------------|
| `claude_code` | Execute prompt in Claude Code session |
| `file_create` / `file_read` / `file_write` / `file_delete` | File operations |
| `git_init` / `git_commit` / `git_push` | Git operations |
| `shell` | Run a shell command |
| `notify_user` | Send a message back to the user |
| `wait` | Sleep for a duration |
| `custom` | User-defined tool |

**File:** `app/task/executor.ts`

---

## 6. Claude Code Integration

**File:** `app/claude-code/bridge.ts`

The bridge wraps the `claude-code-js` SDK to manage Claude Code sessions:

```
claude_code task handler:
  │
  ├─ openSession({ projectPath })
  │   → new ClaudeCode({ workingDirectory })
  │   → claude.newSession()
  │   → Session status: starting → ready
  │
  ├─ sendPrompt(sessionId, enhancedPrompt)
  │   → sdkSession.prompt({ prompt, systemPrompt })
  │   → Claude Code analyzes, writes code, runs commands
  │   → Returns: { success, result, costUsd, durationMs }
  │
  └─ closeSession(sessionId)
      → Mark completed, remove from active sessions
```

### Session States

```
starting → ready → working → completed
                           → failed
                           → aborted
                  → waiting_for_answer (needs auto-answer)
```

---

## 7. Auto-Answer System

When Claude Code asks a question during a session, the auto-answer system decides whether to respond automatically.

**Files:** `app/auto-answer/index.ts`, `app/auto-answer/rules-parser.ts`, `app/auto-answer/ai-judge.ts`

```
shouldAutoAnswer(question)
  │
  ├─ Tier 1: Obvious patterns (instant, no API call)
  │   YES: "proceed?", "continue?", "is this ok?"
  │   NO:  "delete all", "force push", "reset --hard"
  │
  ├─ Tier 2: Rule files (fast, file lookup)
  │   Session rules  (priority 20)  — from session .md file
  │   Global rules   (priority 10)  — from RULES.md "Always Yes"
  │   Custom rules   (priority 5)   — from RULES.md "Custom Answers"
  │
  └─ Tier 3: AI judgment (API call to Claude)
      → Considers session context, task, previous Q&A
      → Returns: { shouldAnswer, answer, confidence, reasoning }
```

### RULES.md Format

```markdown
## Always Yes
- "proceed" -> "yes"

## Custom Answers
- "test framework" -> "jest"
```

---

## 8. Messaging

**File:** `app/messaging/webapp-adapter.ts`

All communication with the user goes through the WebAppAdapter, which calls the MiloBot server API:

| Endpoint | Purpose |
|----------|---------|
| `POST /agent/heartbeat` | Register liveness, get poll interval |
| `GET /messages/pending` | Fetch unread user messages |
| `POST /messages/ack` | Mark messages as processed |
| `POST /messages/send` | Send response back to user |

The adapter authenticates with `x-api-key` header using `MILO_API_KEY`.

---

## 9. Session Persistence

**File:** `app/session/manager.ts`

Sessions are stored as local markdown files in the workspace:

```
~/milo-workspace/
  SESSION/
    fix-the-login-bug.md      ← active session
    add-dark-mode.md           ← active session
    archive/
      old-session.md           ← archived
```

Each session file contains:

```markdown
# INFO
- Session Name: fix-the-login-bug
- Created: 2026-02-10T12:00:00Z
- Status: IN_PROGRESS

# TASKS
- [x] Notify user: starting
- [ ] Execute Claude Code prompt
- [ ] Notify user: completed

# ENHANCED PROMPT
Fix the issue: the login bug...

# MONITORING
## Auto-answer rules for session:
## Questions/answers from Claude Code:
## Messages to/from user:

# ERROR LOG
```

---

## 10. Tools System

**File:** `app/tools/registry.ts`, `app/tools/executor.ts`

Tools are discovered from the workspace `tools/` directory and registered at startup:

```
discoverTools(toolsDir)
  │
  ├─ *.ts / *.js   → TypeScript/JavaScript handlers
  ├─ *.sh           → Shell scripts (args passed as env vars)
  └─ *.skill.md     → Markdown skill files (prompt extraction)
```

Built-in tools (`app/tools/built-in/`):
- `create-project` — Scaffold a new project
- `init-git-repo` — Initialize a git repository
- `list-files` — List files in a directory

---

## 11. Configuration

**File:** `app/config/index.ts`, `app/config/schema.ts`

Config is loaded from JSON, merged with defaults, and validated with Zod:

```
loadConfig()
  ├─ Load milo.config.json (or defaults)
  ├─ Load .env variables
  ├─ Load API keys from macOS keychain
  └─ Validate with Zod schema
```

Key configuration areas:
- **workspace** — Directory paths (projects, sessions, tools, templates)
- **claudeCode** — Max concurrent sessions, retry settings
- **scheduler** — Heartbeat interval
- **messaging** — Adapter type (webapp/telegram), API URL
- **ai** — Model selection
- **tools** — Safe tools list, confirmation-required tools

---

## 12. Complete End-to-End Example

**User sends:** *"Fix the login bug in my-auth"*

```
 1. Web App → Server stores message

 2. Agent heartbeat fires
    ├─ POST /agent/heartbeat → OK
    └─ GET /messages/pending → [{ content: "Fix the login bug in my-auth" }]

 3. Parse intent
    ├─ Pattern: "<verb> <task> in <project>"
    ├─ verb = "fix", task = "the login bug", project = "my-auth"
    └─ intent = { type: "open_session", confidence: 0.9 }

 4. Open session
    ├─ Resolve "my-auth" → ~/milo-workspace/projects/my-auth
    ├─ Session name: "fix-the-login-bug"
    ├─ Enhance prompt → "Fix the issue: the login bug. Investigate..."
    └─ Create SESSION/fix-the-login-bug.md

 5. Run tasks
    ├─ Task 1: notify_user → "Starting session..."
    ├─ Task 2: claude_code
    │   ├─ Open Claude Code session in ~/milo-workspace/projects/my-auth
    │   ├─ Send enhanced prompt
    │   ├─ Claude Code: reads code, identifies bug, writes fix
    │   └─ Close session → { success: true, costUsd: 0.12 }
    └─ Task 3: notify_user → "Session completed"

 6. Update session status → COMPLETED

 7. POST /messages/send → "Session completed: fix-the-login-bug (3/3 tasks)"

 8. POST /messages/ack → Mark original message as handled

 9. User sees result in Web App
```

---

## Architecture Diagram

```
┌──────────────┐         ┌──────────────┐
│   Web App    │ ──────→ │    Server    │
│  (User UI)   │ ←────── │  (REST API)  │
└──────────────┘         └──────┬───────┘
                                │ polling (heartbeat)
                                ▼
                  ┌─────────────────────────┐
                  │       MiloAgent         │
                  │                         │
                  │  ┌─────────────────┐    │
                  │  │ Intent Parser   │    │
                  │  │ (patterns + AI) │    │
                  │  └────────┬────────┘    │
                  │           │             │
                  │  ┌────────▼────────┐    │
                  │  │ Prompt Enhancer │    │
                  │  │ (templates + AI)│    │
                  │  └────────┬────────┘    │
                  │           │             │
                  │  ┌────────▼────────┐    │
                  │  │  Orchestrator   │    │
                  │  │ (task DAG exec) │    │
                  │  └────────┬────────┘    │
                  │           │             │
                  │  ┌────────▼────────┐    │     ┌──────────────┐
                  │  │  Task Executor  │────│────→│  Claude Code  │
                  │  │ (handlers/tools)│    │     │  (SDK session)│
                  │  └─────────────────┘    │     └──────────────┘
                  │                         │
                  │  ┌─────────────────┐    │
                  │  │  Auto-Answer    │    │
                  │  │ (rules + AI)    │    │
                  │  └─────────────────┘    │
                  │                         │
                  │  ┌─────────────────┐    │
                  │  │ Session Manager │    │
                  │  │ (local .md)     │    │
                  │  └─────────────────┘    │
                  └─────────────────────────┘
```

---

## Key Design Patterns

| Pattern | Description |
|---------|-------------|
| **Polling model** | No persistent connections; periodic heartbeat checks for work |
| **Graceful degradation** | AI available → use it; not available → fall back to templates/patterns |
| **Local-first persistence** | Sessions and config stored as local markdown/JSON files |
| **Handler registry** | Task types and tools register handlers; extensible without modifying core |
| **Dependency-based execution** | Tasks declare dependencies; orchestrator resolves execution order |
| **Three-tier auto-answer** | Obvious patterns → rule files → AI judgment (fast to slow) |
