# Pi-Agent-Core Refactor Design

**Date:** 2026-02-15
**Status:** Approved
**Approach:** Layered Replacement (Worker Core Swap)

## Goal

Replace the worker's dual execution paths (Anthropic SDK chat + claude-code-js bot) with a single `pi-agent-core` Agent backed by `pi-ai`'s multi-provider model API. CLI coding agents (Claude Code, Gemini CLI, Codex CLI) become tools in the agent's tool registry rather than being the sole execution engine.

## Motivation

- **Multi-provider support:** Use any LLM provider (Anthropic, OpenAI, Google, xAI, etc.) instead of being locked to Anthropic SDK and claude-code-js.
- **Direct tool use:** The agent calls LLMs directly with tools (file editing, bash, git, search) rather than delegating everything to Claude Code.
- **CLI agents as tools:** Claude Code, Gemini CLI, Codex CLI, and browser automation are available as tools the LLM can choose to call. The user can also explicitly request a specific tool.
- **Event streaming:** Rich real-time feedback to the user UI via pi-agent-core's event system.

## What Changes

- Worker process internals (new agent engine)
- AI client (multi-provider via pi-ai)
- New tool definitions directory
- New bot-identity system
- Extended IPC protocol
- Config schema (provider/model pairs)

## What Does NOT Change

- Orchestrator process model (parent + child workers)
- IPC transport (JSON Lines over stdin/stdout)
- Database schema and queries
- Messaging adapters (REST, PubNub)
- Inbox/outbox durability layer
- Heartbeat scheduler
- CLI commands (`milo start`, `milo init`, etc.)
- Session persistence (markdown files + SQLite)

---

## 1. Core Architecture

The worker process becomes a thin shell around a pi-agent-core `Agent`. The current two execution paths (`executeChatTask` and `executeClaudeCodeTask`) merge into one unified path.

```
Orchestrator (UNCHANGED)
  ├─ Messaging Adapters
  ├─ Inbox / Outbox
  └─ Session Actor Manager
       │
       │ IPC (unchanged JSON Lines)
       ▼
Worker Process (REFACTORED)
  └─ pi-agent-core Agent
       ├─ pi-ai Model (any provider)
       ├─ System Prompt (from bot-identity + project context)
       └─ Tool Registry
            ├─ read_file, write_file, edit_file
            ├─ bash
            ├─ git_status, git_commit, git_diff
            ├─ glob, grep
            ├─ claude_code_cli
            ├─ gemini_cli
            ├─ codex_cli
            ├─ browser_automation
            └─ notify_user
```

The orchestrator, IPC protocol, session-actor manager, inbox/outbox, DB, messaging adapters, config loading, and heartbeat scheduler are all untouched.

---

## 2. Worker Refactor

The current `worker.ts` has `executeChatTask()` and `executeClaudeCodeTask()` as separate code paths. Both get replaced by a single `executeAgentTask()`.

**Current flow:**

```
WORKER_TASK received
  → if sessionType === 'chat' → Anthropic SDK direct call (no tools)
  → if sessionType === 'bot'  → claude-code-js session.prompt()
```

**New flow:**

```
WORKER_TASK received
  → Create/reuse pi-agent-core Agent
  → Configure model via pi-ai getModel(provider, modelId)
  → Load tool set based on session config
  → agent.prompt(userMessage)
  → Stream events back to orchestrator via IPC
  → Return final result
```

The `sessionType` distinction (`chat` vs `bot`) becomes less important. Every session is an agent session. A "chat" is an agent with no tools (or minimal tools). A "bot" is an agent with the full tool registry. This is controlled by configuration rather than branching code paths.

**Agent lifecycle in the worker:**

```typescript
let agent: Agent | null = null;

async function executeAgentTask(msg: WorkerTaskMessage): Promise<string> {
  if (!agent) {
    agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(botIdentity, projectPath, workspaceDir),
        model: getModel(msg.provider ?? 'anthropic', msg.modelId ?? 'claude-sonnet-4-20250514'),
        tools: loadTools(msg.toolSet, { projectPath, workspaceDir }),
      },
      convertToLlm: (messages) => messages.filter(m =>
        ['user', 'assistant', 'toolResult'].includes(m.role)
      ),
      transformContext: async (messages) => pruneOldMessages(messages, 100),
    });

    agent.subscribe((event) => forwardEventToOrchestrator(event));
  }

  await agent.prompt(msg.prompt);
  return extractResult(agent.state.messages);
}
```

**Cancellation:** `agent.abort()` replaces the current `claudeSession.abort()` hack.

**Steering:** If the user sends a follow-up message while the agent is running tools, the orchestrator forwards it as a steering message via `agent.steer()` instead of cancelling the whole task.

---

## 3. Tool Registry

Tools are defined as pi-agent-core `AgentTool` objects using TypeBox schemas for parameter validation. They live in a new `app/agent-tools/` directory (separate from the existing `app/tools/` plugin system).

### Directory Structure

```
app/agent-tools/
├── index.ts              # loadTools() — assembles tool sets
├── file-tools.ts         # read_file, write_file, edit_file
├── bash-tool.ts          # bash (shell execution)
├── git-tools.ts          # git_status, git_commit, git_diff
├── search-tools.ts       # glob, grep
├── cli-agent-tools.ts    # claude_code_cli, gemini_cli, codex_cli
├── browser-tool.ts       # browser_automation (placeholder)
└── notify-tool.ts        # notify_user (IPC back to orchestrator)
```

### Tool Definition Pattern

```typescript
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",
  description: "Read the contents of a file at a given path",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or project-relative file path" }),
  }),
  execute: async (_toolCallId, params, signal) => {
    const content = await readFile(params.path, "utf-8");
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};
```

### CLI Agent Tools

Each wraps an external CLI agent as a tool the LLM can delegate to:

```typescript
export const claudeCodeTool: AgentTool = {
  name: "claude_code_cli",
  label: "Claude Code",
  description: "Delegate a complex coding task to Claude Code CLI.",
  parameters: Type.Object({
    prompt: Type.String({ description: "The task description for Claude Code" }),
    workingDirectory: Type.Optional(Type.String()),
  }),
  execute: async (_toolCallId, params, signal, onUpdate) => {
    const { ClaudeCode } = await import("claude-code-js");
    const claude = new ClaudeCode({ workingDirectory: params.workingDirectory ?? projectPath });
    const session = claude.newSession();

    onUpdate?.({ content: [{ type: "text", text: "Delegating to Claude Code..." }], details: {} });

    const result = await session.prompt({ prompt: params.prompt });
    return {
      content: [{ type: "text", text: result.result ?? "No output" }],
      details: { cost_usd: result.cost_usd, duration_ms: result.duration_ms },
    };
  },
};
```

### Tool Set Loading

Config-driven assembly. The `loadTools()` function assembles the right set based on session configuration:

```typescript
type ToolSet = 'full' | 'chat' | 'minimal' | string[];

function loadTools(toolSet: ToolSet, ctx: ToolContext): AgentTool[] {
  const coreTools = [readFileTool, writeFileTool, editFileTool, bashTool, ...gitTools, ...searchTools];
  const cliTools  = [claudeCodeTool, geminiCliTool, codexCliTool];
  const uiTools   = [notifyUserTool];

  switch (toolSet) {
    case 'full':    return [...coreTools, ...cliTools, ...uiTools];
    case 'chat':    return [...uiTools];
    case 'minimal': return [...coreTools, ...uiTools];
    default:        return filterByNames(toolSet, [...coreTools, ...cliTools, ...uiTools]);
  }
}
```

The user can say "use Claude Code for this" and the LLM calls `claude_code_cli`. Or the LLM can decide on its own to delegate for complex multi-file tasks while handling simple edits directly.

---

## 4. Event Streaming & IPC Integration

The pi-agent-core Agent emits rich events during execution. These are bridged to the existing IPC protocol so the orchestrator can forward them to the user in real-time.

### New IPC Messages

Added alongside existing `WORKER_READY`, `WORKER_TASK_STARTED`, `WORKER_TASK_DONE`, etc.

**Worker → Orchestrator:**

| IPC Message | Source Event | Purpose |
|-------------|-------------|---------|
| `WORKER_STREAM_TEXT` | `message_update` (text_delta) | Real-time text streaming to UI |
| `WORKER_TOOL_START` | `tool_execution_start` | Show "Reading file..." in UI |
| `WORKER_TOOL_END` | `tool_execution_end` | Show tool result summary |
| `WORKER_TURN` | `turn_start` / `turn_end` | Track multi-turn progress |
| `WORKER_QUESTION` | (from tool safety checks) | Tool needs user confirmation |

**Orchestrator → Worker (new):**

| IPC Message | Purpose |
|-------------|---------|
| `WORKER_STEER` | Forward user message as steering interrupt |
| `WORKER_ANSWER` | Respond to a `WORKER_QUESTION` |

### Type Definitions

```typescript
interface WorkerStreamText {
  type: 'WORKER_STREAM_TEXT';
  sessionId: string;
  taskId: string;
  delta: string;
}

interface WorkerToolStart {
  type: 'WORKER_TOOL_START';
  sessionId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
}

interface WorkerToolEnd {
  type: 'WORKER_TOOL_END';
  sessionId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
  success: boolean;
  summary?: string;
}

interface WorkerQuestion {
  type: 'WORKER_QUESTION';
  sessionId: string;
  taskId: string;
  toolCallId: string;
  question: string;
  options?: string[];
}

interface WorkerSteer {
  type: 'WORKER_STEER';
  prompt: string;
}

interface WorkerAnswer {
  type: 'WORKER_ANSWER';
  toolCallId: string;
  answer: string;
}
```

### Event Forwarding in Worker

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        send({
          type: 'WORKER_STREAM_TEXT', sessionId,
          taskId: currentTaskId!, delta: event.assistantMessageEvent.delta,
        });
      }
      break;
    case 'tool_execution_start':
      send({
        type: 'WORKER_TOOL_START', sessionId,
        taskId: currentTaskId!, toolName: event.toolName, toolCallId: event.toolCallId,
      });
      break;
    case 'tool_execution_end':
      send({
        type: 'WORKER_TOOL_END', sessionId,
        taskId: currentTaskId!, toolName: event.toolName, toolCallId: event.toolCallId,
        success: !event.result?.isError, summary: summarizeToolResult(event.result),
      });
      break;
  }
});
```

### Backpressure

Text streaming can be chatty. The orchestrator should debounce `WORKER_STREAM_TEXT` events before publishing to PubNub (buffer ~100ms of deltas into one message). Tool start/end events are low-volume and forwarded immediately.

### Steering Integration

When the orchestrator receives a user message for a session that's currently running, it forwards as a steering message instead of queueing:

```typescript
// Orchestrator: routing message to busy session
if (actor.status === 'OPEN_RUNNING' && actor.worker) {
  sendToWorker(actor, { type: 'WORKER_STEER', prompt: message.content });
}

// Worker: new handler
case 'WORKER_STEER':
  if (agent) {
    agent.steer({ role: 'user', content: msg.prompt, timestamp: Date.now() });
  }
  break;
```

---

## 5. Model Configuration & AI Client Replacement

The current `utils/ai-client.ts` is an Anthropic-only SDK wrapper. It gets replaced by pi-ai's multi-provider API.

### Config Schema Changes

```typescript
ai: {
  // Model used by the worker's pi-agent-core Agent
  agent: {
    provider: string,   // default: 'anthropic'
    model: string,      // default: 'claude-sonnet-4-20250514'
  },
  // Model used for utility calls (intent parsing, prompt enhancement, auto-answer)
  utility: {
    provider: string,   // default: 'anthropic'
    model: string,      // default: 'claude-haiku-4-5-20251001'
  },
}
```

### New ai-client.ts

Thin wrapper around pi-ai:

```typescript
import { getModel, complete, type Model } from '@mariozechner/pi-ai';

let utilityModel: Model<any> | null = null;

export function initUtilityModel(provider: string, modelId: string): void {
  utilityModel = getModel(provider, modelId);
}

export function isAIAvailable(): boolean {
  return utilityModel !== null;
}

export async function completeUtility(
  prompt: string,
  options: { system?: string; maxTokens?: number } = {}
): Promise<string> {
  if (!utilityModel) throw new Error('Utility model not initialized');

  const response = await complete(utilityModel, {
    systemPrompt: options.system,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}
```

Existing consumers (`intent/parser.ts`, `prompt/enhancer.ts`, `auto-answer/ai-judge.ts`) need only import updates since the function signature is similar.

### Per-Session Model Overrides

The user can say "use GPT-5 for this session" and the orchestrator passes the provider/model in `WORKER_INIT`. Bot-identity files can also specify preferred models via frontmatter.

### Dependency Changes

```
Add:    @mariozechner/pi-agent-core, @mariozechner/pi-ai
Remove: @anthropic-ai/sdk
Move:   claude-code-js → optionalDependencies (only used in claude_code_cli tool)
```

---

## 6. Auto-Answer Adaptation

The auto-answer system stays intact but its integration point changes.

### Scenario 1: CLI Agent Tools Asking Questions

When the agent delegates to Claude Code CLI, the tool wires auto-answer into Claude Code's permission system:

```typescript
export const claudeCodeTool: AgentTool = {
  execute: async (_toolCallId, params, signal, onUpdate) => {
    const claude = new ClaudeCode({
      workingDirectory: params.workingDirectory ?? projectPath,
      permissionMode: 'auto',
      autoAnswer: async (question) => {
        const result = await shouldAutoAnswer(question, autoAnswerOptions);
        if (result.shouldAnswer) return result.answer!;

        send({ type: 'WORKER_QUESTION', sessionId, question, toolCallId: _toolCallId });
        return await waitForUserAnswer(signal);
      },
    });
    // ...
  },
};
```

### Scenario 2: Direct Tool Safety Checks

Direct tools (bash, file_write) use simpler safety checks since the LLM is already making the decisions. Only destructive operations are gated:

```typescript
execute: async (_toolCallId, params, signal) => {
  if (isDangerousCommand(params.command)) {
    ctx.sendIPC({ type: 'WORKER_QUESTION', sessionId: ctx.sessionId, question: `Allow: ${params.command}?`, toolCallId: _toolCallId });
    const approved = await ctx.waitForUserAnswer(_toolCallId, signal);
    if (!approved) throw new Error("User denied command execution");
  }
  // ...
}
```

The worker holds a `Map<toolCallId, Promise resolver>` so that when a `WORKER_ANSWER` arrives via IPC, it resolves the pending promise and tool execution continues.

---

## 7. Bot Identities & Context Management

Users define bot identities as `.md` files in their workspace. Each identity defines expertise, behavior, and optionally preferred model and tool set.

### Workspace Structure

```
~/milo-workspace/
├── agents/                    # Bot-identity definitions
│   ├── default.md             # Default coding assistant
│   ├── anne.md                # Sales expert
│   ├── matt.md                # CTO / systems design
│   ├── dev.md                 # Senior developer
│   └── reviewer.md            # Code reviewer
├── MEMORY.md
├── config.json
└── ...
```

### Bot-Identity File Format

Markdown with frontmatter for structured config:

```markdown
---
name: Matt
role: CTO & Systems Architect
model:
  provider: anthropic
  id: claude-sonnet-4-20250514
toolSet: full
---

# Matt -- CTO & Systems Architect

You are Matt, an experienced CTO and systems architect. You think in terms of
scalability, maintainability, and long-term technical strategy.

## Expertise
- Distributed systems design
- API architecture and microservices
- Database modeling and performance

## Communication Style
- Direct and opinionated, but explains reasoning
- Pushes back on over-engineering
- Frames technical decisions in terms of business impact
```

### Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | filename | Display name |
| `role` | string | -- | Short role description |
| `model.provider` | string | config default | pi-ai provider |
| `model.id` | string | config default | Model ID |
| `toolSet` | string | `'full'` | `full`, `minimal`, `chat`, or array of tool names |

### Loading

```typescript
// app/agents/bot-identity.ts

interface BotIdentity {
  name: string;
  role?: string;
  model?: { provider: string; id: string };
  toolSet?: ToolSet;
  systemPromptBody: string;
  filePath: string;
}

function loadBotIdentity(agentsDir: string, nameOrFile: string): BotIdentity { /* ... */ }
function listBotIdentities(agentsDir: string): BotIdentity[] { /* ... */ }
```

### System Prompt Assembly

The bot-identity body is wrapped with project context and global memory:

```typescript
function buildSystemPrompt(
  identity: BotIdentity,
  projectPath: string,
  workspaceDir: string,
): string {
  const sections: string[] = [];

  // 1. Bot-identity definition (from .md body)
  sections.push(identity.systemPromptBody);

  // 2. Session context
  sections.push(`## Current Session\n- Working directory: ${projectPath}\n- Workspace: ${workspaceDir}`);

  // 3. Capabilities
  sections.push(`## Your Capabilities
You have tools for file operations, shell commands, git, and code search.
You also have access to CLI coding agents (Claude Code, Gemini CLI, Codex CLI)
that you can delegate complex multi-step tasks to.
If a destructive action is needed, your tools will ask the user for confirmation.`);

  // 4. Project context (CLAUDE.md, directory tree)
  const projectCtx = loadProjectContext(projectPath);
  if (projectCtx) sections.push(`## Project Context\n${projectCtx}`);

  // 5. Global user preferences (MEMORY.md)
  const memory = tryReadFile(path.join(workspaceDir, 'MEMORY.md'));
  if (memory) sections.push(`## User Preferences\n${memory}`);

  return sections.join('\n\n');
}
```

### Session Startup

- User says: `@matt design the API for the new billing system`
- Intent parser detects `@matt` as a bot-identity reference
- Orchestrator passes `botIdentity: 'matt'` in `WORKER_INIT`
- Worker loads `agents/matt.md`, builds system prompt, configures model/tools from frontmatter
- Default: `agents/default.md`, falling back to a built-in generic prompt

### Context Management Across Tasks

The agent persists in the worker across multiple tasks within the same session. pi-agent-core's `transformContext` handles pruning:

```typescript
transformContext: async (messages) => {
  const maxMessages = 100;
  if (messages.length <= maxMessages) return messages;

  const head = messages.slice(0, 2);
  const tail = messages.slice(-maxMessages + 2);
  const summary: AgentMessage = {
    role: 'user',
    content: `[Earlier conversation: ${messages.length - maxMessages} messages pruned]`,
    timestamp: Date.now(),
  };

  return [...head, summary, ...tail];
},
```

### Prompt Enhancement

Per-task prompt injection: when the orchestrator sends a new `WORKER_TASK`, the user's message can optionally be enriched by the existing prompt enhancer before passing to the agent.

---

## 8. File-Level Change Map

| File | Action | Notes |
|------|--------|-------|
| `app/orchestrator/worker.ts` | **Rewrite** | Single `executeAgentTask()` using pi-agent-core Agent |
| `app/orchestrator/ipc-types.ts` | **Extend** | Add streaming, tool, question, steer, answer IPC types |
| `app/orchestrator/orchestrator.ts` | **Modify** | Handle new IPC events, steering routing, text debounce |
| `app/orchestrator/session-actor.ts` | **Modify** | Pass botIdentity in WORKER_INIT, forward steering |
| `app/agent-tools/index.ts` | **New** | `loadTools()` assembles tool sets |
| `app/agent-tools/file-tools.ts` | **New** | read_file, write_file, edit_file |
| `app/agent-tools/bash-tool.ts` | **New** | bash (shell execution) |
| `app/agent-tools/git-tools.ts` | **New** | git_status, git_commit, git_diff |
| `app/agent-tools/search-tools.ts` | **New** | glob, grep |
| `app/agent-tools/cli-agent-tools.ts` | **New** | claude_code_cli, gemini_cli, codex_cli |
| `app/agent-tools/browser-tool.ts` | **New** | browser_automation (placeholder) |
| `app/agent-tools/notify-tool.ts` | **New** | notify_user (IPC to orchestrator) |
| `app/agents/bot-identity.ts` | **New** | Load/parse bot-identity `.md` files |
| `app/utils/ai-client.ts` | **Rewrite** | Thin wrapper around pi-ai `complete()` |
| `app/intent/parser.ts` | **Modify** | Add bot-identity detection (`@name`) |
| `app/intent/patterns.ts` | **Modify** | Add regex for `@<bot-identity>` references |
| `app/config/schema.ts` | **Modify** | Add `ai.agent` and `ai.utility` provider/model config |
| `app/claude-code/bridge.ts` | **Delete** | Moves into `agent-tools/cli-agent-tools.ts` |
| `app/claude-code/types.ts` | **Delete** | No longer needed |
| `app/claude-code/index.ts` | **Delete** | No longer needed |
| `app/task/orchestrator.ts` | **Keep** | Not touched, can deprecate later |
| `app/task/executor.ts` | **Keep** | Not touched |
| `app/prompt/enhancer.ts` | **Keep** | Still useful for enriching user messages |
| `app/auto-answer/` | **Keep** | Used inside `claude_code_cli` tool |
| `app/session/` | **Keep** | Unchanged |
| `app/messaging/` | **Keep** | Unchanged |
| `app/db/` | **Keep** | Unchanged |
| `app/scheduler/` | **Keep** | Unchanged |

### Dependency Changes

```
Add:    @mariozechner/pi-agent-core, @mariozechner/pi-ai
Remove: @anthropic-ai/sdk
Move:   claude-code-js → optionalDependencies
```
