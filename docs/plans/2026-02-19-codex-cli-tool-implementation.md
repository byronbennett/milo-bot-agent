# Codex CLI Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a production-ready `codex_cli` agent tool that spawns the Codex CLI binary, parses JSONL events, and forwards them to the orchestrator — with feature parity to the existing `claude_code` tool.

**Architecture:** Spawn `codex exec --json` as a child process from the worker. Parse JSONL events from stdout incrementally. Map Codex events (`thread.started`, `item.*`, `turn.*`) to existing IPC event types (`stream_text`, `tool_start`, `tool_end`). Track session IDs in memory for resume support.

**Tech Stack:** TypeScript, Node.js `child_process.spawn`, existing pi-agent-core `AgentTool` interface, existing IPC event system.

---

## Critical Differences from Existing Draft Plan

The previous draft plan (now superseded by this document) had several issues identified during research:

1. **Wrong event type casing**: Draft used `agent_message` / `command_execution` (snake_case). Actual Codex JSONL uses `agentMessage` / `commandExecution` (camelCase).
2. **Missing streaming deltas**: Codex emits `item.agentMessage.delta`, `item.commandExecution.outputDelta`, etc. between `item.started` and `item.completed`. These are essential for real-time visibility and the draft ignored them entirely.
3. **Missing `fileChange` events**: Codex emits `fileChange` items for file edits with diffs. These should be forwarded as tool events.
4. **No TDD**: Tests were deferred to the end instead of driving implementation.
5. **Tasks too coarse**: 7 large tasks instead of bite-sized TDD steps.
6. **No `turn.failed` error mapping**: Codex provides structured `codexErrorInfo` values (`ContextWindowExceeded`, `Unauthorized`, etc.) that should map to user-friendly messages.
7. **No question handling discussion**: With `-a never`, Codex declines operations and emits `declined` status on items. These need surfacing.

## Approach Decision: Subprocess vs SDK

**`@openai/codex-sdk`** exists (`npm install @openai/codex-sdk`) and provides typed TypeScript bindings with `startThread()` / `runStreamed()` / `resumeThread()`. However, we choose **subprocess spawning** for Phase 1 because:

- The SDK internally spawns the CLI binary anyway — it's an abstraction over the same JSONL protocol
- Subprocess gives us full control over flags, environment, and process lifecycle
- Follows the proven pattern from `claude-code-oauth-tool.ts` (disabled but working code)
- No additional dependency to track for breaking changes
- The SDK's event type system can be replicated with simple TypeScript interfaces

Phase 2 can migrate to the SDK once it's more battle-tested, with zero changes to the tool contract.

## Codex JSONL Event Reference

When `codex exec --json` runs, stdout emits one JSON object per line:

| Event Type | Key Fields | Maps To |
|---|---|---|
| `thread.started` | `thread_id` (UUID) | Capture as session_id |
| `turn.started` | — | (informational) |
| `item.started` | `item.type`: `agentMessage`, `commandExecution`, `fileChange`, `reasoning`, `plan`, etc. | `tool_start` for commandExecution/fileChange |
| `item.agentMessage.delta` | `delta` (text fragment) | `stream_text` IPC event |
| `item.commandExecution.outputDelta` | `delta` (stdout/stderr fragment) | `stream_text` IPC event |
| `item.completed` | Full item object with `status`, `exitCode`, `aggregatedOutput`, etc. | `tool_end` for commandExecution/fileChange; capture text for agentMessage |
| `turn.completed` | `usage.input_tokens`, `usage.output_tokens` | Capture for details |
| `turn.failed` | `error.message`, `error.codexErrorInfo` | Accumulate error text |
| `error` | `message` | Accumulate error text |

Item types within `item.started` / `item.completed`:
- `agentMessage` — model text response (`text` field)
- `commandExecution` — shell command (`command`, `cwd`, `status`, `exitCode`, `aggregatedOutput`)
- `fileChange` — file edits (`changes[]` with `path`, `kind`, `diff`)
- `reasoning` — internal reasoning (`summary`, `content`)
- `plan` — task plan (`text`)
- `mcpToolCall`, `webSearch`, `imageView` — other tool types

---

## Detailed Tasks

### Task 1: Define Codex event types

**Files:**
- Create: `app/agent-tools/codex-event-types.ts`
- Test: `__tests__/agent-tools/codex-event-handler.test.ts`

**Step 1: Create the type definitions file**

```typescript
// app/agent-tools/codex-event-types.ts

/**
 * TypeScript interfaces for Codex CLI JSONL events.
 *
 * Reference: https://developers.openai.com/codex/noninteractive/
 * These are emitted by `codex exec --json` on stdout, one JSON object per line.
 */

// --- Top-level event types ---

export interface CodexThreadStarted {
  type: 'thread.started';
  thread_id: string;
}

export interface CodexTurnStarted {
  type: 'turn.started';
}

export interface CodexTurnCompleted {
  type: 'turn.completed';
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface CodexTurnFailed {
  type: 'turn.failed';
  error: {
    message: string;
    codexErrorInfo?: string;
    additionalDetails?: string;
  };
}

export interface CodexError {
  type: 'error';
  message: string;
}

// --- Item types ---

export interface CodexAgentMessageItem {
  id: string;
  type: 'agentMessage';
  text?: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: 'commandExecution';
  command?: string;
  cwd?: string;
  status?: 'inProgress' | 'completed' | 'failed' | 'declined';
  exitCode?: number;
  durationMs?: number;
  aggregatedOutput?: string;
}

export interface CodexFileChangeItem {
  id: string;
  type: 'fileChange';
  changes?: Array<{ path: string; kind: string; diff?: string }>;
  status?: 'inProgress' | 'completed' | 'failed' | 'declined';
}

export interface CodexReasoningItem {
  id: string;
  type: 'reasoning';
  summary?: string;
  content?: string;
}

export interface CodexPlanItem {
  id: string;
  type: 'plan';
  text?: string;
}

export interface CodexGenericItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export type CodexItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexReasoningItem
  | CodexPlanItem
  | CodexGenericItem;

export interface CodexItemStarted {
  type: 'item.started';
  item: CodexItem;
}

export interface CodexItemCompleted {
  type: 'item.completed';
  item: CodexItem;
}

// --- Streaming delta events ---

export interface CodexAgentMessageDelta {
  type: 'item.agentMessage.delta';
  delta: string;
}

export interface CodexCommandOutputDelta {
  type: 'item.commandExecution.outputDelta';
  delta: string;
}

export interface CodexFileChangeDelta {
  type: 'item.fileChange.outputDelta';
  delta: string;
}

export interface CodexReasoningDelta {
  type: 'item.reasoning.summaryTextDelta' | 'item.reasoning.textDelta';
  delta: string;
}

export interface CodexPlanDelta {
  type: 'item.plan.delta';
  delta: string;
}

// --- Union of all events ---

export type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexError
  | CodexItemStarted
  | CodexItemCompleted
  | CodexAgentMessageDelta
  | CodexCommandOutputDelta
  | CodexFileChangeDelta
  | CodexReasoningDelta
  | CodexPlanDelta
  | { type: string; [key: string]: unknown }; // catch-all for unknown events
```

**Step 2: Commit**

```bash
git add app/agent-tools/codex-event-types.ts
git commit -m "feat(codex): add TypeScript type definitions for Codex JSONL events"
```

---

### Task 2: Implement Codex event handler — core parsing

**Files:**
- Create: `app/agent-tools/codex-event-handler.ts`
- Test: `__tests__/agent-tools/codex-event-handler.test.ts`

**Step 1: Write the failing test for thread.started**

```typescript
// __tests__/agent-tools/codex-event-handler.test.ts
import { handleCodexEvent, type CodexEventCallbacks, type CodexEventState } from '../../app/agent-tools/codex-event-handler.js';

function makeCallbacks(overrides: Partial<CodexEventCallbacks> = {}): CodexEventCallbacks {
  return {
    onSessionId: jest.fn(),
    onAssistantText: jest.fn(),
    onUsage: jest.fn(),
    onError: jest.fn(),
    sendIpcEvent: jest.fn(),
    ...overrides,
  };
}

describe('handleCodexEvent', () => {
  describe('thread.started', () => {
    it('calls onSessionId with the thread_id', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({ type: 'thread.started', thread_id: 'abc-123' }, cb, state);

      expect(cb.onSessionId).toHaveBeenCalledWith('abc-123');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-event-handler.test.ts -v`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// app/agent-tools/codex-event-handler.ts

/**
 * Codex CLI JSONL event handler.
 *
 * Processes events emitted by `codex exec --json` and forwards them
 * to the orchestrator via IPC events. Mirrors the role of
 * claude-event-handler.ts for Claude Code.
 */

import type { CodexEvent, CodexItem } from './codex-event-types.js';

export interface CodexEventCallbacks {
  onSessionId: (id: string) => void;
  onAssistantText: (text: string) => void;
  onUsage: (usage: { input_tokens?: number; output_tokens?: number }) => void;
  onError: (message: string) => void;
  sendIpcEvent: (event: {
    type: 'tool_start' | 'tool_end' | 'stream_text' | 'progress';
    toolName?: string;
    toolCallId?: string;
    delta?: string;
    message?: string;
    success?: boolean;
    summary?: string;
  }) => void;
}

export interface CodexEventState {
  lastAssistantText: string;
  errors: string[];
}

/**
 * Process a single parsed Codex JSONL event.
 */
export function handleCodexEvent(
  event: CodexEvent,
  callbacks: CodexEventCallbacks,
  state: CodexEventState,
): void {
  switch (event.type) {
    case 'thread.started':
      callbacks.onSessionId(event.thread_id);
      break;

    case 'turn.completed':
      if (event.usage) {
        callbacks.onUsage(event.usage);
      }
      break;

    case 'turn.failed':
      if ('error' in event && event.error) {
        const info = event.error.codexErrorInfo
          ? ` (${event.error.codexErrorInfo})`
          : '';
        const msg = `${event.error.message}${info}`;
        state.errors.push(msg);
        callbacks.onError(msg);
      }
      break;

    case 'error':
      if ('message' in event) {
        state.errors.push(event.message);
        callbacks.onError(event.message);
      }
      break;

    case 'item.started':
      handleItemStarted(event.item, callbacks);
      break;

    case 'item.completed':
      handleItemCompleted(event.item, callbacks, state);
      break;

    // Streaming deltas
    case 'item.agentMessage.delta':
      if ('delta' in event && event.delta) {
        callbacks.sendIpcEvent({ type: 'stream_text', delta: event.delta });
      }
      break;

    case 'item.commandExecution.outputDelta':
      if ('delta' in event && event.delta) {
        callbacks.sendIpcEvent({ type: 'stream_text', delta: event.delta });
      }
      break;

    // Ignore other events silently (turn.started, reasoning deltas, plan deltas, etc.)
    default:
      break;
  }
}

function handleItemStarted(item: CodexItem, callbacks: CodexEventCallbacks): void {
  switch (item.type) {
    case 'commandExecution':
      callbacks.sendIpcEvent({
        type: 'tool_start',
        toolName: `Codex:command`,
        toolCallId: item.id,
        message: item.command,
      });
      break;

    case 'fileChange':
      callbacks.sendIpcEvent({
        type: 'tool_start',
        toolName: `Codex:fileChange`,
        toolCallId: item.id,
      });
      break;

    // Don't emit IPC for agentMessage, reasoning, plan starts
    default:
      break;
  }
}

function handleItemCompleted(
  item: CodexItem,
  callbacks: CodexEventCallbacks,
  state: CodexEventState,
): void {
  // Surface declined items as warnings
  if ('status' in item && item.status === 'declined') {
    const what = item.type === 'commandExecution' && 'command' in item
      ? `command: ${item.command}`
      : item.type;
    callbacks.sendIpcEvent({
      type: 'progress',
      message: `[Codex declined] ${what}`,
    });
    callbacks.sendIpcEvent({
      type: 'tool_end',
      toolName: `Codex:${item.type}`,
      toolCallId: item.id,
      success: false,
      summary: `Declined: ${what}`,
    });
    return;
  }

  switch (item.type) {
    case 'agentMessage':
      if (item.text) {
        state.lastAssistantText = item.text;
        callbacks.onAssistantText(item.text);
      }
      break;

    case 'commandExecution': {
      const success = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === undefined);
      const summary = item.command
        ? `${item.command} → exit ${item.exitCode ?? '?'}`
        : undefined;
      callbacks.sendIpcEvent({
        type: 'tool_end',
        toolName: `Codex:command`,
        toolCallId: item.id,
        success,
        summary,
      });
      break;
    }

    case 'fileChange': {
      const paths = item.changes?.map((c) => c.path).join(', ') ?? '';
      callbacks.sendIpcEvent({
        type: 'tool_end',
        toolName: `Codex:fileChange`,
        toolCallId: item.id,
        success: item.status === 'completed',
        summary: paths ? `Changed: ${paths}` : undefined,
      });
      break;
    }

    default:
      break;
  }
}

/**
 * Parse a single line of JSONL output. Returns the parsed event or null
 * if the line is empty or not valid JSON.
 */
export function parseCodexLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-event-handler.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/codex-event-handler.ts __tests__/agent-tools/codex-event-handler.test.ts
git commit -m "feat(codex): add event handler with thread.started support"
```

---

### Task 3: Event handler — item events and streaming deltas

**Files:**
- Modify: `__tests__/agent-tools/codex-event-handler.test.ts`

**Step 1: Add tests for all item types and deltas**

Add these test cases to the existing describe block:

```typescript
  describe('item.started — commandExecution', () => {
    it('emits tool_start IPC event', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.started',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/proj' },
      }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_start',
        toolName: 'Codex:command',
        toolCallId: 'cmd-1',
        message: 'npm test',
      });
    });
  });

  describe('item.started — fileChange', () => {
    it('emits tool_start IPC event', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.started',
        item: { id: 'fc-1', type: 'fileChange', changes: [], status: 'inProgress' },
      }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'tool_start',
        toolName: 'Codex:fileChange',
        toolCallId: 'fc-1',
      });
    });
  });

  describe('item.completed — agentMessage', () => {
    it('captures assistant text and calls onAssistantText', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agentMessage', text: 'Done! All tests pass.' },
      }, cb, state);

      expect(cb.onAssistantText).toHaveBeenCalledWith('Done! All tests pass.');
      expect(state.lastAssistantText).toBe('Done! All tests pass.');
    });
  });

  describe('item.completed — commandExecution', () => {
    it('emits tool_end with success for exit code 0', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-1', type: 'commandExecution',
          command: 'npm test', status: 'completed', exitCode: 0,
        },
      }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_end',
        toolName: 'Codex:command',
        toolCallId: 'cmd-1',
        success: true,
      }));
    });

    it('emits tool_end with failure for non-zero exit', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-2', type: 'commandExecution',
          command: 'npm test', status: 'failed', exitCode: 1,
        },
      }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_end',
        success: false,
      }));
    });
  });

  describe('item.completed — fileChange', () => {
    it('emits tool_end with changed file paths', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.completed',
        item: {
          id: 'fc-1', type: 'fileChange', status: 'completed',
          changes: [{ path: 'src/main.ts', kind: 'edit' }],
        },
      }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_end',
        toolName: 'Codex:fileChange',
        summary: 'Changed: src/main.ts',
        success: true,
      }));
    });
  });

  describe('streaming deltas', () => {
    it('forwards agentMessage delta as stream_text', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({ type: 'item.agentMessage.delta', delta: 'Hello ' }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'stream_text',
        delta: 'Hello ',
      });
    });

    it('forwards commandExecution output delta as stream_text', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({ type: 'item.commandExecution.outputDelta', delta: 'PASS' }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith({
        type: 'stream_text',
        delta: 'PASS',
      });
    });
  });

  describe('turn.completed', () => {
    it('calls onUsage with token counts', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'turn.completed',
        usage: { input_tokens: 1000, output_tokens: 200 },
      }, cb, state);

      expect(cb.onUsage).toHaveBeenCalledWith({ input_tokens: 1000, output_tokens: 200 });
    });
  });

  describe('turn.failed', () => {
    it('accumulates error with codexErrorInfo', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'turn.failed',
        error: { message: 'Rate limit exceeded', codexErrorInfo: 'UsageLimitExceeded' },
      }, cb, state);

      expect(state.errors).toContain('Rate limit exceeded (UsageLimitExceeded)');
      expect(cb.onError).toHaveBeenCalled();
    });
  });

  describe('item.completed — declined operation', () => {
    it('emits progress warning and tool_end with failure for declined items', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      handleCodexEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-declined', type: 'commandExecution',
          command: 'rm -rf /', status: 'declined',
        },
      }, cb, state);

      expect(cb.sendIpcEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'progress',
        message: expect.stringContaining('declined'),
      }));
      expect(cb.sendIpcEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_end',
        success: false,
        summary: expect.stringContaining('Declined'),
      }));
    });
  });

  describe('unknown events', () => {
    it('ignores unknown event types without throwing', () => {
      const cb = makeCallbacks();
      const state: CodexEventState = { lastAssistantText: '', errors: [] };

      expect(() => {
        handleCodexEvent({ type: 'some.future.event' } as any, cb, state);
      }).not.toThrow();
    });
  });

  describe('parseCodexLine', () => {
    it('parses valid JSON', () => {
      const result = parseCodexLine('{"type":"thread.started","thread_id":"abc"}');
      expect(result).toEqual({ type: 'thread.started', thread_id: 'abc' });
    });

    it('returns null for empty line', () => {
      expect(parseCodexLine('')).toBeNull();
      expect(parseCodexLine('   ')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseCodexLine('not json')).toBeNull();
    });
  });
```

**Step 2: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-event-handler.test.ts -v`
Expected: PASS (implementation already written in Task 2)

**Step 3: Commit**

```bash
git add __tests__/agent-tools/codex-event-handler.test.ts
git commit -m "test(codex): add comprehensive event handler tests"
```

---

### Task 4: Implement Codex CLI runtime helpers — binary finder

**Files:**
- Create: `app/agent-tools/codex-cli-runtime.ts`
- Test: `__tests__/agent-tools/codex-cli-runtime.test.ts`

**Step 1: Write the failing test**

```typescript
// __tests__/agent-tools/codex-cli-runtime.test.ts
import { buildCodexArgs, CODEX_TIMEOUT_MS } from '../../app/agent-tools/codex-cli-runtime.js';

describe('buildCodexArgs', () => {
  it('builds args for a new session', () => {
    const args = buildCodexArgs({
      prompt: 'fix the tests',
      cwd: '/home/user/project',
    });

    expect(args).toEqual([
      '-a', 'never',
      '-s', 'workspace-write',
      '-C', '/home/user/project',
      'exec',
      '--json',
      '--skip-git-repo-check',
      'fix the tests',
    ]);
  });

  it('builds args for a resume session', () => {
    const args = buildCodexArgs({
      prompt: 'now add tests',
      cwd: '/home/user/project',
      sessionId: 'sess-abc-123',
    });

    expect(args).toEqual([
      '-a', 'never',
      '-s', 'workspace-write',
      '-C', '/home/user/project',
      'exec',
      '--json',
      '--skip-git-repo-check',
      'resume',
      'sess-abc-123',
      'now add tests',
    ]);
  });

  it('includes model flag when provided', () => {
    const args = buildCodexArgs({
      prompt: 'say hi',
      cwd: '/proj',
      model: 'o3',
    });

    expect(args).toContain('-m');
    expect(args).toContain('o3');
    // -m and model should appear before 'exec'
    const mIdx = args.indexOf('-m');
    const execIdx = args.indexOf('exec');
    expect(mIdx).toBeLessThan(execIdx);
  });
});

describe('CODEX_TIMEOUT_MS', () => {
  it('is 30 minutes', () => {
    expect(CODEX_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-cli-runtime.test.ts -v`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// app/agent-tools/codex-cli-runtime.ts

/**
 * Codex CLI process runtime helpers.
 *
 * Handles binary discovery, argument construction, and process lifecycle
 * for spawning `codex exec --json` as a child process.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CODEX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Cache the resolved codex binary path
let cachedBinary: string | null = null;

export interface CodexArgs {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
}

/**
 * Find the `codex` CLI binary.
 * Checks: PATH (via `which`), common install paths.
 * Throws with install guidance if not found.
 */
export async function findCodexBinary(): Promise<string> {
  if (cachedBinary) return cachedBinary;

  // 1. Try PATH via `which`
  const whichResult = await new Promise<string | null>((resolve) => {
    const proc = spawn('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });

  if (whichResult) {
    cachedBinary = whichResult;
    return whichResult;
  }

  // 2. Check common locations
  const candidates = [
    join(homedir(), '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }

  throw new Error(
    'Codex CLI binary not found. Please install it:\n' +
    '  npm install -g @openai/codex\n' +
    'Then authenticate with:\n' +
    '  Set OPENAI_API_KEY environment variable, or run: codex login',
  );
}

/**
 * Reset the cached binary path (for testing).
 */
export function resetBinaryCache(): void {
  cachedBinary = null;
}

/**
 * Build the command-line arguments for `codex exec --json`.
 *
 * New session:
 *   codex -a never -s workspace-write -C <cwd> [-m model] exec --json --skip-git-repo-check <prompt>
 *
 * Resume session:
 *   codex -a never -s workspace-write -C <cwd> [-m model] exec --json --skip-git-repo-check resume <sessionId> <prompt>
 */
export function buildCodexArgs(opts: CodexArgs): string[] {
  const args: string[] = [
    '-a', 'never',
    '-s', 'workspace-write',
    '-C', opts.cwd,
  ];

  if (opts.model) {
    args.push('-m', opts.model);
  }

  args.push('exec', '--json', '--skip-git-repo-check');

  if (opts.sessionId) {
    args.push('resume', opts.sessionId, opts.prompt);
  } else {
    args.push(opts.prompt);
  }

  return args;
}

/**
 * Kill a child process with escalating signals.
 * SIGINT -> (4s) SIGTERM -> (3s) SIGKILL
 */
export function escalatingKill(proc: ChildProcess): void {
  try { proc.kill('SIGINT'); } catch { /* already dead */ }

  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* */ }
    }
  }, 4000);

  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch { /* */ }
    }
  }, 7000);
}
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-cli-runtime.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/codex-cli-runtime.ts __tests__/agent-tools/codex-cli-runtime.test.ts
git commit -m "feat(codex): add CLI runtime helpers — binary finder, arg builder, escalating kill"
```

---

### Task 5: Implement Codex tool parameters and schema

**Files:**
- Modify: `app/agent-tools/cli-agent-tools.ts`

**Step 1: Add CodexParams schema and knownCodexSessionIds set**

Replace the `SimplePromptParams` import usage for codex and add:

```typescript
// Add after ClaudeCodeParams definition (line 24)

const CodexParams = Type.Object({
  prompt: Type.String({ description: 'Detailed task description or follow-up message for Codex CLI' }),
  sessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing Codex session by thread ID. Omit to start a new session. ' +
        'Use this to continue a multi-turn conversation with Codex.',
    }),
  ),
  workingDirectory: Type.Optional(
    Type.String({ description: 'Override working directory (default: project directory)' }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Override model (default: gpt-5.3-codex). Examples: o3, gpt-5.3-codex' }),
  ),
});

// Add after knownSessionIds (line 31)
const knownCodexSessionIds = new Set<string>();
```

**Step 2: Update the codexCliTool stub to use new params**

Replace the codexCliTool definition (lines 197-206) with:

```typescript
  const codexCliTool: AgentTool<typeof CodexParams> = {
    name: 'codex_cli',
    label: 'OpenAI Codex CLI (AI Coding Agent)',
    description:
      'Delegate a coding task to OpenAI Codex CLI. Codex can read/write files, run commands, and execute multi-step coding workflows autonomously. ' +
      'Use this for coding work with OpenAI models. ' +
      'Supports multi-turn conversations: the first call returns a session_id, pass it back on subsequent calls to continue.',
    parameters: CodexParams,
    execute: async (_toolCallId, _params) => {
      assertProjectConfirmed(ctx.projectPath, ctx.workspaceDir);
      throw new Error('Codex CLI integration is not yet implemented.');
    },
  };
```

**Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add app/agent-tools/cli-agent-tools.ts
git commit -m "feat(codex): add CodexParams schema with session resume and model support"
```

---

### Task 6: Implement codex_cli.execute — main execution function

**Files:**
- Modify: `app/agent-tools/cli-agent-tools.ts`
- Test: `__tests__/agent-tools/codex-cli-tool.test.ts`

**Step 1: Write the failing test for successful execution**

```typescript
// __tests__/agent-tools/codex-cli-tool.test.ts
import { jest } from '@jest/globals';

// Mock child_process before importing the module under test
const mockSpawn = jest.fn();
jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
}));

// Mock the runtime module
const mockFindCodexBinary = jest.fn<() => Promise<string>>();
jest.unstable_mockModule('../../app/agent-tools/codex-cli-runtime.js', () => ({
  findCodexBinary: mockFindCodexBinary,
  buildCodexArgs: (await import('../../app/agent-tools/codex-cli-runtime.js')).buildCodexArgs,
  escalatingKill: jest.fn(),
  CODEX_TIMEOUT_MS: 30 * 60 * 1000,
  resetBinaryCache: jest.fn(),
}));

// Now import the module under test
const { createCliAgentTools } = await import('../../app/agent-tools/cli-agent-tools.js');

import { EventEmitter } from 'events';
import { Readable } from 'stream';

/**
 * Helper: create a mock child process that emits JSONL events.
 */
function createMockProcess(jsonlLines: string[], exitCode = 0) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = jest.fn(() => { proc.killed = true; });
  proc.pid = 12345;

  // Emit lines async
  setImmediate(() => {
    for (const line of jsonlLines) {
      stdout.push(line + '\n');
    }
    stdout.push(null); // EOF
    stderr.push(null);
    proc.emit('close', exitCode);
  });

  return proc;
}

function makeCtx() {
  return {
    projectPath: '/tmp/milo-workspace/PROJECTS/my-project',
    workspaceDir: '/tmp/milo-workspace',
    sessionId: 'test-session',
    sessionName: 'test',
    currentTaskId: () => 'task-1',
    sendNotification: jest.fn(),
    askUser: jest.fn(),
    sendIpcEvent: jest.fn(),
  };
}

describe('codex_cli tool', () => {
  beforeEach(() => {
    mockFindCodexBinary.mockResolvedValue('/usr/local/bin/codex');
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    jest.restoreAllMocks();
  });

  it('executes a prompt and returns assistant text with session_id', async () => {
    const proc = createMockProcess([
      '{"type":"thread.started","thread_id":"sess-001"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"msg-1","type":"agentMessage"}}',
      '{"type":"item.agentMessage.delta","delta":"Done!"}',
      '{"type":"item.completed","item":{"id":"msg-1","type":"agentMessage","text":"Done! All tests pass."}}',
      '{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":50}}',
    ]);
    mockSpawn.mockReturnValue(proc);

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    const result = await codexTool.execute('call-1', {
      prompt: 'fix the tests',
    }, undefined, jest.fn());

    expect(result.content[0].text).toContain('Done! All tests pass.');
    expect(result.content[0].text).toContain('sess-001');
    expect(result.details?.session_id).toBe('sess-001');
    expect(result.details?.usage).toEqual({ input_tokens: 500, output_tokens: 50 });
  });

  it('returns error message on non-zero exit with no events', async () => {
    const proc = createMockProcess([], 1);
    // Push stderr
    setImmediate(() => {
      proc.stderr.push('Error: unauthorized\n');
      proc.stderr.push(null);
    });
    mockSpawn.mockReturnValue(proc);

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    await expect(
      codexTool.execute('call-2', { prompt: 'test' }, undefined, jest.fn()),
    ).rejects.toThrow(/unauthorized/i);
  });

  it('throws if binary not found', async () => {
    mockFindCodexBinary.mockRejectedValue(new Error('Codex CLI binary not found'));

    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    await expect(
      codexTool.execute('call-3', { prompt: 'test' }, undefined, jest.fn()),
    ).rejects.toThrow(/not found/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-cli-tool.test.ts -v`
Expected: FAIL — tool still throws "not yet implemented"

**Step 3: Replace the codex_cli execute function in `cli-agent-tools.ts`**

Add these imports to the top of cli-agent-tools.ts:

```typescript
import { spawn } from 'child_process';
import {
  findCodexBinary,
  buildCodexArgs,
  escalatingKill,
  CODEX_TIMEOUT_MS,
} from './codex-cli-runtime.js';
import {
  handleCodexEvent,
  parseCodexLine,
  type CodexEventState,
} from './codex-event-handler.js';
```

Replace the codexCliTool execute function:

```typescript
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const codexBinary = await findCodexBinary();
      const cwd = params.workingDirectory ?? ctx.projectPath;
      assertProjectConfirmed(cwd, ctx.workspaceDir);
      const isResume = params.sessionId && knownCodexSessionIds.has(params.sessionId);

      onUpdate?.({
        content: [{
          type: 'text',
          text: isResume
            ? `Resuming Codex session ${params.sessionId}...`
            : 'Starting new Codex CLI session...',
        }],
        details: {},
      });

      const args = buildCodexArgs({
        prompt: params.prompt,
        cwd,
        sessionId: isResume ? params.sessionId : undefined,
        model: params.model,
      });

      // Pass API key through environment
      const env = { ...process.env };
      if (env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
        env.CODEX_API_KEY = env.OPENAI_API_KEY;
      }

      const startTime = Date.now();

      const proc = spawn(codexBinary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      // Wire abort signal
      const onAbort = () => escalatingKill(proc);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Process timeout
      const timeout = setTimeout(() => {
        escalatingKill(proc);
      }, CODEX_TIMEOUT_MS);

      let sessionId: string | undefined;
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;
      const state: CodexEventState = { lastAssistantText: '', errors: [] };
      let stderrOutput = '';

      // Collect stderr
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      // Parse JSONL from stdout
      await new Promise<void>((resolve, reject) => {
        let buffer = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          let idx: number;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);

            const event = parseCodexLine(line);
            if (!event) continue;

            handleCodexEvent(event, {
              onSessionId: (id) => {
                sessionId = id;
                knownCodexSessionIds.add(id);
              },
              onAssistantText: () => { /* state tracks this */ },
              onUsage: (u) => { usage = u; },
              onError: () => { /* state tracks this */ },
              sendIpcEvent: (evt) => ctx.sendIpcEvent?.(evt),
            }, state);
          }
        });

        proc.on('close', (code) => {
          clearTimeout(timeout);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }

          if (code !== 0 && !state.lastAssistantText && state.errors.length === 0) {
            const lowerStderr = stderrOutput.toLowerCase();
            if (lowerStderr.includes('auth') || lowerStderr.includes('unauthorized') || lowerStderr.includes('login')) {
              reject(new Error(
                'Codex CLI authentication failed. Please either:\n' +
                '  1. Set OPENAI_API_KEY via `milo init`\n' +
                '  2. Run: codex login\n\n' +
                `Stderr: ${stderrOutput.slice(0, 500)}`,
              ));
              return;
            }
            reject(new Error(
              `Codex CLI exited with code ${code}.\nStderr: ${stderrOutput.slice(0, 500)}`,
            ));
            return;
          }

          resolve();
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        });
      });

      const durationMs = Date.now() - startTime;

      // Build output
      let output: string;
      if (state.errors.length > 0) {
        output = state.lastAssistantText
          ? `${state.lastAssistantText}\n\nErrors: ${state.errors.join('; ')}`
          : `Codex ended with errors: ${state.errors.join('; ')}`;
      } else {
        output = state.lastAssistantText || 'No output from Codex.';
      }

      return {
        content: [{
          type: 'text',
          text: output +
            (sessionId
              ? `\n\n[Codex session_id: ${sessionId} — pass this to continue the conversation]`
              : ''),
        }],
        details: {
          session_id: sessionId,
          usage,
          duration_ms: durationMs,
        },
      };
    },
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-cli-tool.test.ts -v`
Expected: PASS

**Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add app/agent-tools/cli-agent-tools.ts __tests__/agent-tools/codex-cli-tool.test.ts
git commit -m "feat(codex): implement codex_cli.execute with subprocess spawning and JSONL parsing"
```

---

### Task 7: Add cancellation and timeout tests

**Files:**
- Modify: `__tests__/agent-tools/codex-cli-tool.test.ts`

**Step 1: Add cancellation test**

```typescript
  it('kills process when abort signal fires', async () => {
    const proc = createMockProcess([
      '{"type":"thread.started","thread_id":"sess-cancel"}',
    ], 0);
    // Override: don't auto-close, we'll abort
    proc.stdout.destroy = jest.fn();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const ctx = makeCtx();
    const tools = createCliAgentTools(ctx);
    const codexTool = tools.find((t) => t.name === 'codex_cli')!;

    // Start execution then abort
    const promise = codexTool.execute('call-cancel', {
      prompt: 'long task',
    }, controller.signal, jest.fn());

    // Wait a tick for process to start, then abort
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    // The process should emit close after kill
    setImmediate(() => proc.emit('close', null));

    const result = await promise;
    expect(result.content[0].text).toContain('No output from Codex');
  });
```

**Step 2: Run tests**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/codex-cli-tool.test.ts -v`
Expected: PASS

**Step 3: Commit**

```bash
git add __tests__/agent-tools/codex-cli-tool.test.ts
git commit -m "test(codex): add cancellation test for codex_cli tool"
```

---

### Task 8: Update load-tools test to verify codex_cli presence

**Files:**
- Modify: `__tests__/agent-tools/load-tools.test.ts`

**Step 1: Add codex_cli assertion to the full set test**

Add to the 'full set includes core, cli, and ui tools' test:

```typescript
    expect(names).toContain('codex_cli');
```

Also add a test:

```typescript
  it('codex_cli tool has correct parameter schema', () => {
    const tools = loadTools('full', ctx);
    const codex = tools.find((t) => t.name === 'codex_cli');
    expect(codex).toBeDefined();
    expect(codex!.parameters.properties).toHaveProperty('prompt');
    expect(codex!.parameters.properties).toHaveProperty('sessionId');
    expect(codex!.parameters.properties).toHaveProperty('workingDirectory');
    expect(codex!.parameters.properties).toHaveProperty('model');
  });
```

**Step 2: Run all agent-tools tests**

Run: `pnpm test -- __tests__/agent-tools/`
Expected: PASS

**Step 3: Commit**

```bash
git add __tests__/agent-tools/load-tools.test.ts
git commit -m "test(codex): verify codex_cli presence and schema in tool loading tests"
```

---

### Task 9: Update orchestrator status output

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`

**Step 1: Locate the agent names set and status output**

The orchestrator already has `codex_cli` in `agentNames` (line 1303). Verify the `/status` output includes Codex auth guidance alongside Claude Code auth guidance.

Search for Claude-related status messaging and add a parallel Codex note. The exact changes depend on what's already there, but the pattern should be:

```typescript
// In the status builder, after the Claude Code note:
if (agents.some((a) => a.name === 'codex_cli')) {
  statusLines.push('  Codex CLI: Requires OPENAI_API_KEY or `codex login`');
}
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(codex): add Codex auth note to /status output"
```

---

### Task 10: Run full validation

**Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 2: Run all tests**

Run: `pnpm test`
Expected: PASS

**Step 3: Run agent-tools tests specifically**

Run: `pnpm test -- __tests__/agent-tools/`
Expected: PASS

---

## Validation Checklist

```bash
pnpm typecheck
pnpm test -- __tests__/agent-tools/
pnpm test
```

Manual smoke checks (requires Codex CLI installed and authenticated):

```bash
# Verify binary found
which codex

# New session
codex -a never -s workspace-write -C <project> exec --json "Say hi"

# Resume (grab thread_id from above output)
codex -a never -s workspace-write -C <project> exec --json resume <thread-id> "Continue"
```

In-agent smoke:

- Call `codex_cli` with a simple prompt
- Confirm session_id is returned in details
- Call again with `sessionId` and verify continuity
- Confirm `Codex:command` and `Codex:fileChange` events appear in progress stream

## Files Created/Modified Summary

| Action | File | Purpose |
|--------|------|---------|
| Create | `app/agent-tools/codex-event-types.ts` | TypeScript interfaces for Codex JSONL events |
| Create | `app/agent-tools/codex-event-handler.ts` | Event parser and IPC forwarder |
| Create | `app/agent-tools/codex-cli-runtime.ts` | Binary finder, arg builder, escalating kill |
| Modify | `app/agent-tools/cli-agent-tools.ts` | Replace stub with full implementation |
| Modify | `app/orchestrator/orchestrator.ts` | Status output for Codex auth |
| Create | `__tests__/agent-tools/codex-event-handler.test.ts` | Event handler unit tests |
| Create | `__tests__/agent-tools/codex-cli-runtime.test.ts` | Runtime helper unit tests |
| Create | `__tests__/agent-tools/codex-cli-tool.test.ts` | Integration tests with mocked spawn |
| Modify | `__tests__/agent-tools/load-tools.test.ts` | Codex presence assertion |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Event format drift across Codex versions | Tolerant parser with catch-all for unknown events; camelCase types verified against current docs |
| Auth ambiguity (login vs API key) | Pass both `OPENAI_API_KEY` and `CODEX_API_KEY` env vars; error messages guide both paths |
| Non-interactive approval prompts causing hangs | `-a never` flag enforced; `declined` status on items surfaced as warnings via progress events |
| Missing Codex binary on host | Fast-fail with specific install instructions (npm, brew, binary) |
| No mid-execution steering support | Documented limitation; `-a never` means Codex makes all decisions autonomously |
| Non-zero exit code suppressing output | Use `aggregatedOutput` from item.completed when available; capture stderr separately |

## Phase 2 (Optional): SDK Upgrade Path

When Phase 1 is stable, evaluate replacing subprocess with `@openai/codex-sdk`:

```typescript
import { Codex } from "@openai/codex-sdk";
const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
const thread = codex.startThread({ workingDirectory: cwd });
const { events } = await thread.runStreamed(prompt);
for await (const event of events) { /* same event types */ }
```

Benefits: typed events, handles binary discovery internally, cleaner API.
Keeps same tool contract (`prompt`, `sessionId`, `workingDirectory`, `model`).

## References

- OpenAI Codex CLI docs: https://developers.openai.com/codex/cli/
- Codex CLI reference (flags): https://developers.openai.com/codex/cli/reference/
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive/
- Codex authentication: https://developers.openai.com/codex/auth/
- Codex SDK: https://developers.openai.com/codex/sdk/
- Codex app-server: https://developers.openai.com/codex/app-server/
- GitHub: openai/codex: https://github.com/openai/codex
