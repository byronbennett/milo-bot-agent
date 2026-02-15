# Pi-Agent-Core Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the worker's dual execution engine (Anthropic SDK + claude-code-js) with a single pi-agent-core Agent backed by pi-ai multi-provider models, with CLI agents as tools.

**Architecture:** Each worker process creates one pi-agent-core Agent instance with a configurable tool registry. The orchestrator/IPC shell stays intact. Bot-identity `.md` files define agent personas with model/tool overrides.

**Tech Stack:** `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@sinclair/typebox` (re-exported by pi-ai)

**Design doc:** `docs/plans/2026-02-15-pi-agent-core-refactor-design.md`

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Add new dependencies and remove old ones**

```bash
pnpm add @mariozechner/pi-agent-core @mariozechner/pi-ai
pnpm remove @anthropic-ai/sdk
```

**Step 2: Move claude-code-js to optionalDependencies**

In `package.json`, move `"claude-code-js"` from `dependencies` to `optionalDependencies`:

```json
{
  "optionalDependencies": {
    "claude-code-js": "^0.4.0"
  }
}
```

Remove `"claude-code-js": "^0.4.0"` from the `dependencies` block.

**Step 3: Verify install and typecheck**

```bash
pnpm install
pnpm typecheck
```

Expected: Typecheck will fail (imports of `@anthropic-ai/sdk` are broken). That's fine — we fix them in subsequent tasks.

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: swap deps for pi-agent-core refactor"
```

---

### Task 2: Update Config Schema

**Files:**
- Modify: `app/config/schema.ts:46-48` (replace `aiConfigSchema`)

**Step 1: Write the failing test**

Create `__tests__/config/schema.test.ts`:

```typescript
import { agentConfigSchema } from '../../app/config/schema.js';

describe('Config Schema', () => {
  it('accepts ai.agent and ai.utility with defaults', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
    });

    expect(config.ai.agent.provider).toBe('anthropic');
    expect(config.ai.agent.model).toBe('claude-sonnet-4-20250514');
    expect(config.ai.utility.provider).toBe('anthropic');
    expect(config.ai.utility.model).toBe('claude-haiku-4-5-20251001');
  });

  it('accepts custom provider and model', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
      ai: {
        agent: { provider: 'openai', model: 'gpt-4o' },
        utility: { provider: 'google', model: 'gemini-2.5-flash' },
      },
    });

    expect(config.ai.agent.provider).toBe('openai');
    expect(config.ai.agent.model).toBe('gpt-4o');
    expect(config.ai.utility.provider).toBe('google');
    expect(config.ai.utility.model).toBe('gemini-2.5-flash');
  });

  it('still accepts legacy ai.model and maps to agent model', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
      ai: { model: 'claude-sonnet-4-5' },
    });

    // Legacy field preserved for backwards compat
    expect(config.ai.model).toBe('claude-sonnet-4-5');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- __tests__/config/schema.test.ts
```

Expected: FAIL — `config.ai.agent` is undefined.

**Step 3: Update the config schema**

In `app/config/schema.ts`, replace the `aiConfigSchema` (lines 46-48) with:

```typescript
const aiModelConfigSchema = z.object({
  provider: z.string().default('anthropic'),
  model: z.string(),
});

export const aiConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-5'),  // Legacy, kept for backwards compat
  agent: aiModelConfigSchema.default({
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  }),
  utility: aiModelConfigSchema.default({
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
  }),
});
```

**Step 4: Run test to verify it passes**

```bash
pnpm test -- __tests__/config/schema.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add app/config/schema.ts __tests__/config/schema.test.ts
git commit -m "feat: add multi-provider ai config (agent + utility)"
```

---

### Task 3: Rewrite AI Client

**Files:**
- Rewrite: `app/utils/ai-client.ts`

**Step 1: Write the failing test**

Create `__tests__/utils/ai-client.test.ts`:

```typescript
import { initUtilityModel, isAIAvailable, getUtilityModel } from '../../app/utils/ai-client.js';

describe('AI Client', () => {
  it('isAIAvailable returns false before init', () => {
    expect(isAIAvailable()).toBe(false);
  });

  it('initializes utility model', () => {
    // This will call pi-ai getModel which needs the provider to be valid
    initUtilityModel('anthropic', 'claude-haiku-4-5-20251001');
    expect(isAIAvailable()).toBe(true);
  });

  it('getUtilityModel returns the model after init', () => {
    initUtilityModel('anthropic', 'claude-haiku-4-5-20251001');
    const model = getUtilityModel();
    expect(model).toBeDefined();
    expect(model!.id).toBe('claude-haiku-4-5-20251001');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- __tests__/utils/ai-client.test.ts
```

Expected: FAIL — functions don't exist yet or have wrong signatures.

**Step 3: Rewrite ai-client.ts**

Replace the entire content of `app/utils/ai-client.ts`:

```typescript
/**
 * AI Client — pi-ai wrapper
 *
 * Provides utility AI calls for intent parsing, prompt enhancement,
 * and auto-answer. Uses pi-ai's multi-provider API.
 */

import { getModel, complete, type Model } from '@mariozechner/pi-ai';

let utilityModel: Model<any> | null = null;

/**
 * Initialize the utility model used for non-agent AI calls.
 */
export function initUtilityModel(provider: string, modelId: string): void {
  utilityModel = getModel(provider as any, modelId as any);
}

/**
 * Get the utility model (or null if not initialized).
 */
export function getUtilityModel(): Model<any> | null {
  return utilityModel;
}

/**
 * Check if the AI client is available.
 */
export function isAIAvailable(): boolean {
  return utilityModel !== null;
}

/**
 * Options for AI completion.
 */
export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Get a completion from the utility model.
 *
 * @param prompt - The user prompt
 * @param options - Optional parameters
 * @returns The assistant's response text
 */
export async function completeUtility(
  prompt: string,
  options: CompletionOptions = {},
): Promise<string> {
  if (!utilityModel) {
    throw new Error('Utility model not initialized. Call initUtilityModel() first.');
  }

  const response = await complete(utilityModel, {
    systemPrompt: options.system,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from AI');
  }

  return textBlock.text;
}

/**
 * Backwards-compatible alias. Existing callers use `complete()`.
 */
export { completeUtility as complete };

/**
 * Estimate token count for a string (rough approximation).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to approximately fit within token limit.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}
```

Note: We export `completeUtility as complete` so existing callers (`intent/parser.ts`, `prompt/enhancer.ts`, `auto-answer/ai-judge.ts`) don't need import changes yet. The old `getAIClient()`, `setAIModel()`, `getAIModel()` functions are removed.

**Step 4: Fix callers that import removed functions**

Search for imports of removed functions (`getAIClient`, `setAIModel`, `getAIModel`) and update them. The `complete` export stays compatible. Any file importing `getAIClient` directly (to call `ai.messages.create`) needs to switch to `completeUtility`.

Check these files:
- `app/intent/parser.ts:16` — imports `complete, isAIAvailable` — no change needed
- `app/auto-answer/ai-judge.ts` — imports `complete, isAIAvailable` — check and fix if needed
- `app/prompt/enhancer.ts` — imports `complete, isAIAvailable` — check and fix if needed
- Any other file referencing `@anthropic-ai/sdk` directly — remove those imports

**Step 5: Run tests**

```bash
pnpm test -- __tests__/utils/ai-client.test.ts
```

Expected: PASS

**Step 6: Typecheck**

```bash
pnpm typecheck
```

Fix any remaining type errors from removed `@anthropic-ai/sdk` imports. The worker.ts will have errors — that's expected (fixed in Task 8).

**Step 7: Commit**

```bash
git add app/utils/ai-client.ts __tests__/utils/ai-client.test.ts
git commit -m "feat: replace Anthropic SDK with pi-ai in ai-client"
```

---

### Task 4: Extend IPC Types

**Files:**
- Modify: `app/orchestrator/ipc-types.ts`

**Step 1: Write the failing test**

Add to `__tests__/orchestrator/ipc.test.ts`:

```typescript
test('sendIPC handles new streaming event types', () => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(chunk.toString()));

  const msg: IPCMessage = {
    type: 'WORKER_STREAM_TEXT',
    sessionId: 's1',
    taskId: 't1',
    delta: 'Hello ',
  };

  sendIPC(stream, msg);
  stream.end();

  const parsed = JSON.parse(chunks.join('').trim());
  expect(parsed.type).toBe('WORKER_STREAM_TEXT');
  expect(parsed.delta).toBe('Hello ');
});

test('sendIPC handles WORKER_STEER message', () => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(chunk.toString()));

  const msg: IPCMessage = {
    type: 'WORKER_STEER',
    prompt: 'Do this instead',
  };

  sendIPC(stream, msg);
  stream.end();

  const parsed = JSON.parse(chunks.join('').trim());
  expect(parsed.type).toBe('WORKER_STEER');
  expect(parsed.prompt).toBe('Do this instead');
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- __tests__/orchestrator/ipc.test.ts
```

Expected: FAIL — TypeScript error, `WORKER_STREAM_TEXT` is not a valid type.

**Step 3: Add new IPC types**

In `app/orchestrator/ipc-types.ts`, add after `WorkerCloseMessage` (line 42):

```typescript
export interface WorkerSteerMessage {
  type: 'WORKER_STEER';
  prompt: string;
}

export interface WorkerAnswerMessage {
  type: 'WORKER_ANSWER';
  toolCallId: string;
  answer: string;
}
```

Update `OrchestratorToWorker` union (line 44-48):

```typescript
export type OrchestratorToWorker =
  | WorkerInitMessage
  | WorkerTaskMessage
  | WorkerCancelMessage
  | WorkerCloseMessage
  | WorkerSteerMessage
  | WorkerAnswerMessage;
```

Add after `WorkerProgressMessage` (line 93):

```typescript
export interface WorkerStreamTextMessage {
  type: 'WORKER_STREAM_TEXT';
  sessionId: string;
  taskId: string;
  delta: string;
}

export interface WorkerToolStartMessage {
  type: 'WORKER_TOOL_START';
  sessionId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
}

export interface WorkerToolEndMessage {
  type: 'WORKER_TOOL_END';
  sessionId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
  success: boolean;
  summary?: string;
}

export interface WorkerQuestionMessage {
  type: 'WORKER_QUESTION';
  sessionId: string;
  taskId: string;
  toolCallId: string;
  question: string;
  options?: string[];
}
```

Update `WorkerToOrchestrator` union (line 95-101):

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
  | WorkerQuestionMessage;
```

Also update `WorkerInitMessage` to include `botIdentity` (line 8-19):

```typescript
export interface WorkerInitMessage {
  type: 'WORKER_INIT';
  sessionId: string;
  sessionName: string;
  sessionType: 'chat' | 'bot';
  projectPath: string;
  workspaceDir: string;
  botIdentity?: string;
  config: {
    agentProvider?: string;
    agentModel?: string;
    utilityProvider?: string;
    utilityModel?: string;
    toolSet?: string;
  };
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test -- __tests__/orchestrator/ipc.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add app/orchestrator/ipc-types.ts __tests__/orchestrator/ipc.test.ts
git commit -m "feat: extend IPC types for streaming, steering, and bot-identity"
```

---

### Task 5: Create Bot-Identity Loader

**Files:**
- Create: `app/agents/bot-identity.ts`
- Create: `app/agents/index.ts`

**Step 1: Write the failing test**

Create `__tests__/agents/bot-identity.test.ts`:

```typescript
import { loadBotIdentity, listBotIdentities, parseFrontmatter } from '../../app/agents/bot-identity.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Bot Identity', () => {
  let agentsDir: string;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'milo-test-'));
    agentsDir = join(tmp, 'agents');
    mkdirSync(agentsDir);
  });

  describe('parseFrontmatter', () => {
    it('parses YAML frontmatter and body', () => {
      const content = `---
name: Matt
role: CTO
model:
  provider: anthropic
  id: claude-sonnet-4-20250514
toolSet: full
---

# Matt

You are Matt, a CTO.`;

      const result = parseFrontmatter(content);
      expect(result.frontmatter.name).toBe('Matt');
      expect(result.frontmatter.role).toBe('CTO');
      expect(result.frontmatter.model.provider).toBe('anthropic');
      expect(result.frontmatter.toolSet).toBe('full');
      expect(result.body).toContain('You are Matt');
    });

    it('handles missing frontmatter', () => {
      const content = '# Just a body\n\nNo frontmatter here.';
      const result = parseFrontmatter(content);
      expect(result.frontmatter).toEqual({});
      expect(result.body).toContain('Just a body');
    });
  });

  describe('loadBotIdentity', () => {
    it('loads a bot-identity by name', () => {
      writeFileSync(join(agentsDir, 'matt.md'), `---
name: Matt
role: CTO
---

You are Matt.`);

      const identity = loadBotIdentity(agentsDir, 'matt');
      expect(identity.name).toBe('Matt');
      expect(identity.role).toBe('CTO');
      expect(identity.systemPromptBody).toContain('You are Matt');
    });

    it('uses filename as name when frontmatter name is missing', () => {
      writeFileSync(join(agentsDir, 'dev.md'), 'You are a developer.');

      const identity = loadBotIdentity(agentsDir, 'dev');
      expect(identity.name).toBe('dev');
    });

    it('returns null for non-existent identity', () => {
      const identity = loadBotIdentity(agentsDir, 'nobody');
      expect(identity).toBeNull();
    });
  });

  describe('listBotIdentities', () => {
    it('lists all .md files in agents dir', () => {
      writeFileSync(join(agentsDir, 'a.md'), 'Agent A');
      writeFileSync(join(agentsDir, 'b.md'), 'Agent B');

      const identities = listBotIdentities(agentsDir);
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.name).sort()).toEqual(['a', 'b']);
    });

    it('returns empty array if dir does not exist', () => {
      const identities = listBotIdentities('/nonexistent/path');
      expect(identities).toEqual([]);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- __tests__/agents/bot-identity.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement bot-identity.ts**

Create `app/agents/bot-identity.ts`:

```typescript
/**
 * Bot Identity Loader
 *
 * Loads and parses bot-identity .md files from the workspace agents/ directory.
 * Each file defines a persona with optional model/tool configuration via YAML frontmatter.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

export interface BotIdentity {
  name: string;
  role?: string;
  model?: { provider: string; id: string };
  toolSet?: string | string[];
  systemPromptBody: string;
  filePath: string;
}

interface Frontmatter {
  name?: string;
  role?: string;
  model?: { provider: string; id: string };
  toolSet?: string | string[];
  [key: string]: unknown;
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Supports simple key: value, nested objects (one level), and arrays.
 */
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {} as Frontmatter, body: content.trim() };
  }

  const yamlBlock = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter: Record<string, unknown> = {};

  let currentKey = '';
  let currentObj: Record<string, unknown> | null = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    // Nested key (indented with spaces)
    if (/^\s{2,}\w/.test(line) && currentKey) {
      const nestedMatch = trimmed.match(/^\s+(\w+):\s*(.+)$/);
      if (nestedMatch) {
        if (!currentObj) currentObj = {};
        currentObj[nestedMatch[1]] = nestedMatch[2].trim();
      }
      continue;
    }

    // Top-level key
    if (currentKey && currentObj) {
      frontmatter[currentKey] = currentObj;
      currentObj = null;
    }

    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value === '') {
        // Next lines are nested
        currentObj = {};
      } else {
        frontmatter[currentKey] = value;
        currentKey = '';
      }
    }
  }

  // Flush last nested object
  if (currentKey && currentObj) {
    frontmatter[currentKey] = currentObj;
  }

  return { frontmatter: frontmatter as Frontmatter, body: body.trim() };
}

/**
 * Load a bot-identity by name (without .md extension) or filename.
 * Returns null if not found.
 */
export function loadBotIdentity(agentsDir: string, nameOrFile: string): BotIdentity | null {
  const fileName = nameOrFile.endsWith('.md') ? nameOrFile : `${nameOrFile}.md`;
  const filePath = join(agentsDir, fileName);

  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    name: (frontmatter.name as string) ?? basename(fileName, '.md'),
    role: frontmatter.role as string | undefined,
    model: frontmatter.model as { provider: string; id: string } | undefined,
    toolSet: frontmatter.toolSet as string | string[] | undefined,
    systemPromptBody: body,
    filePath,
  };
}

/**
 * List all bot-identities in the agents directory.
 */
export function listBotIdentities(agentsDir: string): BotIdentity[] {
  if (!existsSync(agentsDir)) return [];

  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  return files
    .map((f) => loadBotIdentity(agentsDir, f))
    .filter((id): id is BotIdentity => id !== null);
}
```

Create `app/agents/index.ts`:

```typescript
export { loadBotIdentity, listBotIdentities, parseFrontmatter, type BotIdentity } from './bot-identity.js';
```

**Step 4: Run test to verify it passes**

```bash
pnpm test -- __tests__/agents/bot-identity.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add app/agents/ __tests__/agents/
git commit -m "feat: add bot-identity loader for agent personas"
```

---

### Task 6: Create Agent Tools — Core Tools

**Files:**
- Create: `app/agent-tools/file-tools.ts`
- Create: `app/agent-tools/bash-tool.ts`
- Create: `app/agent-tools/search-tools.ts`
- Create: `app/agent-tools/git-tools.ts`
- Create: `app/agent-tools/notify-tool.ts`

**Step 1: Write the failing test**

Create `__tests__/agent-tools/file-tools.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFileTools } from '../../app/agent-tools/file-tools.js';

describe('File Tools', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'milo-tools-'));
  });

  it('read_file reads a file', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world');
    const tools = createFileTools(tmpDir);
    const readTool = tools.find((t) => t.name === 'read_file')!;

    const result = await readTool.execute('tc1', { path: 'test.txt' }, new AbortController().signal);
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('write_file creates a file', async () => {
    const tools = createFileTools(tmpDir);
    const writeTool = tools.find((t) => t.name === 'write_file')!;

    await writeTool.execute('tc1', { path: 'new.txt', content: 'created' }, new AbortController().signal);

    const { readFileSync } = await import('fs');
    expect(readFileSync(join(tmpDir, 'new.txt'), 'utf-8')).toBe('created');
  });

  it('read_file throws for missing file', async () => {
    const tools = createFileTools(tmpDir);
    const readTool = tools.find((t) => t.name === 'read_file')!;

    await expect(
      readTool.execute('tc1', { path: 'nope.txt' }, new AbortController().signal)
    ).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- __tests__/agent-tools/file-tools.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement file-tools.ts**

Create `app/agent-tools/file-tools.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, isAbsolute } from 'path';

export function createFileTools(projectPath: string): AgentTool[] {
  function resolve(p: string): string {
    return isAbsolute(p) ? p : join(projectPath, p);
  }

  const readFileTool: AgentTool = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file. Path can be absolute or relative to the project directory.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path (absolute or project-relative)' }),
    }),
    execute: async (_toolCallId, params, _signal) => {
      const fullPath = resolve(params.path);
      const content = await readFile(fullPath, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
        details: { path: fullPath, size: content.length },
      };
    },
  };

  const writeFileTool: AgentTool = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file, creating parent directories if needed. Overwrites existing files.',
    parameters: Type.Object({
      path: Type.String({ description: 'File path (absolute or project-relative)' }),
      content: Type.String({ description: 'Content to write' }),
    }),
    execute: async (_toolCallId, params, _signal) => {
      const fullPath = resolve(params.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Wrote ${params.content.length} characters to ${params.path}` }],
        details: { path: fullPath },
      };
    },
  };

  return [readFileTool, writeFileTool];
}
```

**Step 4: Implement bash-tool.ts**

Create `app/agent-tools/bash-tool.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\s/i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bdrop\s+(table|database)/i,
  /\bsudo\s/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

export function createBashTool(projectPath: string): AgentTool {
  return {
    name: 'bash',
    label: 'Run Command',
    description: 'Execute a shell command in the project directory. Returns stdout and stderr.',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to run' }),
    }),
    execute: async (_toolCallId, params, signal) => {
      // Note: Dangerous command gating is handled by the worker via WORKER_QUESTION IPC.
      // The tool itself just executes. The worker wraps this with safety checks.
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', params.command], {
          cwd: projectPath,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 10,
          signal: signal as AbortSignal,
        });

        const output = [stdout, stderr].filter(Boolean).join('\n---stderr---\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { command: params.command },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Command failed: ${msg}`);
      }
    },
  };
}
```

**Step 5: Implement search-tools.ts**

Create `app/agent-tools/search-tools.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const execFileAsync = promisify(execFile);

export function createSearchTools(projectPath: string): AgentTool[] {
  const listFilesTool: AgentTool = {
    name: 'list_files',
    label: 'List Files',
    description: 'List files in a directory, optionally with a glob pattern. Returns file paths relative to project root.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory path (default: project root)' })),
      pattern: Type.Optional(Type.String({ description: 'Glob pattern to filter (e.g., "**/*.ts")' })),
      maxDepth: Type.Optional(Type.Number({ description: 'Max directory depth (default: 3)' })),
    }),
    execute: async (_toolCallId, params, _signal) => {
      const dir = params.path ?? '.';
      const maxDepth = params.maxDepth ?? 3;
      const files: string[] = [];

      function walk(currentPath: string, depth: number) {
        if (depth > maxDepth) return;
        try {
          const entries = readdirSync(join(projectPath, currentPath));
          for (const entry of entries) {
            if (entry.startsWith('.') || entry === 'node_modules') continue;
            const relPath = join(currentPath, entry);
            const stat = statSync(join(projectPath, relPath));
            if (stat.isDirectory()) {
              files.push(relPath + '/');
              walk(relPath, depth + 1);
            } else {
              files.push(relPath);
            }
          }
        } catch { /* skip unreadable dirs */ }
      }

      walk(dir === '.' ? '' : dir, 0);
      return {
        content: [{ type: 'text', text: files.join('\n') || '(empty directory)' }],
        details: { count: files.length },
      };
    },
  };

  const grepTool: AgentTool = {
    name: 'grep',
    label: 'Search Content',
    description: 'Search file contents using grep/ripgrep. Returns matching lines with file paths and line numbers.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regex pattern to search for' }),
      path: Type.Optional(Type.String({ description: 'Directory or file to search in (default: project root)' })),
      glob: Type.Optional(Type.String({ description: 'File glob filter (e.g., "*.ts")' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const searchPath = params.path ?? '.';
      const args = ['-rn', '--max-count=50'];
      if (params.glob) args.push('--include', params.glob);
      args.push(params.pattern, searchPath);

      try {
        const { stdout } = await execFileAsync('grep', args, {
          cwd: projectPath,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          signal: signal as AbortSignal,
        });
        return {
          content: [{ type: 'text', text: stdout || 'No matches found.' }],
          details: { pattern: params.pattern },
        };
      } catch (err: unknown) {
        // grep exits 1 when no matches
        const exitErr = err as { code?: number; stdout?: string };
        if (exitErr.code === 1) {
          return {
            content: [{ type: 'text', text: 'No matches found.' }],
            details: { pattern: params.pattern },
          };
        }
        throw err;
      }
    },
  };

  return [listFilesTool, grepTool];
}
```

**Step 6: Implement git-tools.ts**

Create `app/agent-tools/git-tools.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function createGitTools(projectPath: string): AgentTool[] {
  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectPath,
      timeout: 30_000,
    });
    return stdout.trim();
  }

  const gitStatusTool: AgentTool = {
    name: 'git_status',
    label: 'Git Status',
    description: 'Show the working tree status (git status).',
    parameters: Type.Object({}),
    execute: async () => {
      const output = await git('status');
      return { content: [{ type: 'text', text: output }] };
    },
  };

  const gitDiffTool: AgentTool = {
    name: 'git_diff',
    label: 'Git Diff',
    description: 'Show changes in the working directory (git diff). Optionally diff staged changes.',
    parameters: Type.Object({
      staged: Type.Optional(Type.Boolean({ description: 'Show staged changes only' })),
      file: Type.Optional(Type.String({ description: 'Diff a specific file' })),
    }),
    execute: async (_toolCallId, params) => {
      const args = ['diff'];
      if (params.staged) args.push('--staged');
      if (params.file) args.push(params.file);
      const output = await git(...args);
      return { content: [{ type: 'text', text: output || '(no changes)' }] };
    },
  };

  const gitCommitTool: AgentTool = {
    name: 'git_commit',
    label: 'Git Commit',
    description: 'Stage files and create a git commit.',
    parameters: Type.Object({
      message: Type.String({ description: 'Commit message' }),
      files: Type.Optional(Type.Array(Type.String(), { description: 'Files to stage (default: all changed)' })),
    }),
    execute: async (_toolCallId, params) => {
      if (params.files && params.files.length > 0) {
        await git('add', ...params.files);
      } else {
        await git('add', '-A');
      }
      const output = await git('commit', '-m', params.message);
      return { content: [{ type: 'text', text: output }] };
    },
  };

  const gitLogTool: AgentTool = {
    name: 'git_log',
    label: 'Git Log',
    description: 'Show recent commit history.',
    parameters: Type.Object({
      count: Type.Optional(Type.Number({ description: 'Number of commits to show (default: 10)' })),
    }),
    execute: async (_toolCallId, params) => {
      const n = params.count ?? 10;
      const output = await git('log', `--oneline`, `-${n}`);
      return { content: [{ type: 'text', text: output }] };
    },
  };

  return [gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool];
}
```

**Step 7: Implement notify-tool.ts**

Create `app/agent-tools/notify-tool.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

/**
 * The notify tool needs access to the worker's IPC send function.
 * This is injected via the factory.
 */
export function createNotifyTool(sendFn: (message: string) => void): AgentTool {
  return {
    name: 'notify_user',
    label: 'Notify User',
    description: 'Send a message or progress update to the user. Use this to communicate important status, ask questions, or share results.',
    parameters: Type.Object({
      message: Type.String({ description: 'The message to send to the user' }),
    }),
    execute: async (_toolCallId, params) => {
      sendFn(params.message);
      return {
        content: [{ type: 'text', text: `Notified user: ${params.message}` }],
      };
    },
  };
}
```

**Step 8: Run tests**

```bash
pnpm test -- __tests__/agent-tools/file-tools.test.ts
```

Expected: PASS

**Step 9: Commit**

```bash
git add app/agent-tools/ __tests__/agent-tools/
git commit -m "feat: add core agent tools (file, bash, search, git, notify)"
```

---

### Task 7: Create Agent Tools — CLI Agent Tools & Index

**Files:**
- Create: `app/agent-tools/cli-agent-tools.ts`
- Create: `app/agent-tools/browser-tool.ts`
- Create: `app/agent-tools/index.ts`

**Step 1: Implement cli-agent-tools.ts**

Create `app/agent-tools/cli-agent-tools.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

/**
 * Creates CLI agent tools that delegate to external coding CLIs.
 * Each tool lazily imports its SDK so missing optional deps don't break startup.
 */
export function createCliAgentTools(projectPath: string): AgentTool[] {
  const claudeCodeTool: AgentTool = {
    name: 'claude_code_cli',
    label: 'Claude Code',
    description:
      'Delegate a complex coding task to Claude Code CLI. Best for multi-file refactors, large features, or tasks that benefit from Claude Code\'s specialized coding capabilities. Claude Code has its own tool set and can read/write files, run commands, and search code.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Detailed task description for Claude Code' }),
      workingDirectory: Type.Optional(
        Type.String({ description: 'Override working directory (default: project directory)' }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, onUpdate) => {
      let ClaudeCode;
      try {
        const mod = await import('claude-code-js');
        ClaudeCode = mod.ClaudeCode;
      } catch {
        throw new Error(
          'claude-code-js is not installed. Install it with: pnpm add claude-code-js',
        );
      }

      onUpdate?.({
        content: [{ type: 'text', text: 'Delegating to Claude Code...' }],
        details: {},
      });

      const claude = new ClaudeCode({
        workingDirectory: params.workingDirectory ?? projectPath,
      });
      const session = claude.newSession();
      const result = await session.prompt({ prompt: params.prompt });

      return {
        content: [{ type: 'text', text: result.result ?? 'No output from Claude Code.' }],
        details: {
          cost_usd: result.cost_usd,
          duration_ms: result.duration_ms,
        },
      };
    },
  };

  // Placeholder tools for future CLIs
  const geminiCliTool: AgentTool = {
    name: 'gemini_cli',
    label: 'Gemini CLI',
    description: 'Delegate a task to Google Gemini CLI (not yet implemented).',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Task description' }),
    }),
    execute: async () => {
      throw new Error('Gemini CLI integration is not yet implemented.');
    },
  };

  const codexCliTool: AgentTool = {
    name: 'codex_cli',
    label: 'OpenAI Codex CLI',
    description: 'Delegate a task to OpenAI Codex CLI (not yet implemented).',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Task description' }),
    }),
    execute: async () => {
      throw new Error('Codex CLI integration is not yet implemented.');
    },
  };

  return [claudeCodeTool, geminiCliTool, codexCliTool];
}
```

**Step 2: Implement browser-tool.ts (placeholder)**

Create `app/agent-tools/browser-tool.ts`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

export function createBrowserTool(): AgentTool {
  return {
    name: 'browser_automation',
    label: 'Browser',
    description: 'Automate web browser interactions (not yet implemented).',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to navigate to' }),
      action: Type.Optional(Type.String({ description: 'Action to perform' })),
    }),
    execute: async () => {
      throw new Error('Browser automation is not yet implemented.');
    },
  };
}
```

**Step 3: Implement index.ts**

Create `app/agent-tools/index.ts`:

```typescript
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createFileTools } from './file-tools.js';
import { createBashTool, isDangerousCommand } from './bash-tool.js';
import { createSearchTools } from './search-tools.js';
import { createGitTools } from './git-tools.js';
import { createNotifyTool } from './notify-tool.js';
import { createCliAgentTools } from './cli-agent-tools.js';
import { createBrowserTool } from './browser-tool.js';

export { isDangerousCommand } from './bash-tool.js';

export type ToolSet = 'full' | 'chat' | 'minimal' | string[];

export interface ToolContext {
  projectPath: string;
  sendNotification: (message: string) => void;
}

/**
 * Load tools based on the requested tool set.
 */
export function loadTools(toolSet: ToolSet, ctx: ToolContext): AgentTool[] {
  const coreTools = [
    ...createFileTools(ctx.projectPath),
    createBashTool(ctx.projectPath),
    ...createSearchTools(ctx.projectPath),
    ...createGitTools(ctx.projectPath),
  ];
  const cliTools = createCliAgentTools(ctx.projectPath);
  const uiTools = [createNotifyTool(ctx.sendNotification)];

  switch (toolSet) {
    case 'full':
      return [...coreTools, ...cliTools, uiTools[0], createBrowserTool()];
    case 'chat':
      return [...uiTools];
    case 'minimal':
      return [...coreTools, ...uiTools];
    default:
      // Custom list of tool names
      if (Array.isArray(toolSet)) {
        const all = [...coreTools, ...cliTools, ...uiTools, createBrowserTool()];
        return all.filter((t) => toolSet.includes(t.name));
      }
      return [...coreTools, ...uiTools];
  }
}
```

**Step 4: Write test for loadTools**

Create `__tests__/agent-tools/load-tools.test.ts`:

```typescript
import { loadTools } from '../../app/agent-tools/index.js';

describe('loadTools', () => {
  const ctx = { projectPath: '/tmp', sendNotification: () => {} };

  it('full set includes core, cli, and ui tools', () => {
    const tools = loadTools('full', ctx);
    const names = tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('claude_code_cli');
    expect(names).toContain('notify_user');
  });

  it('chat set includes only notify_user', () => {
    const tools = loadTools('chat', ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('notify_user');
  });

  it('minimal set includes core + ui but no cli agents', () => {
    const tools = loadTools('minimal', ctx);
    const names = tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('notify_user');
    expect(names).not.toContain('claude_code_cli');
  });

  it('custom array filters by name', () => {
    const tools = loadTools(['bash', 'read_file'], ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['bash', 'read_file']);
  });
});
```

**Step 5: Run tests**

```bash
pnpm test -- __tests__/agent-tools/
```

Expected: PASS

**Step 6: Commit**

```bash
git add app/agent-tools/ __tests__/agent-tools/
git commit -m "feat: add CLI agent tools, browser placeholder, and loadTools index"
```

---

### Task 8: Rewrite Worker Process

**Files:**
- Rewrite: `app/orchestrator/worker.ts`

This is the core change. Replace the dual `executeChatTask` / `executeClaudeCodeTask` with a single pi-agent-core Agent.

**Step 1: Rewrite worker.ts**

Replace the entire content of `app/orchestrator/worker.ts`:

```typescript
/**
 * Worker process entry point.
 *
 * Spawned by the orchestrator as a child process.
 * Communicates via JSON Lines on stdin (receive) / stdout (send).
 *
 * Each worker runs one pi-agent-core Agent instance that persists across tasks.
 * The agent's model, tools, and system prompt are configured via WORKER_INIT.
 */

import { sendIPC, readIPC } from './ipc.js';
import type {
  WorkerInitMessage,
  WorkerTaskMessage,
  WorkerCancelMessage,
  WorkerSteerMessage,
  WorkerAnswerMessage,
  WorkerToOrchestrator,
} from './ipc-types.js';
import { sendNotification } from '../utils/notify.js';

const ORPHAN_TIMEOUT_MS = 30 * 60 * 1000;

// Worker state
let sessionId = '';
let sessionName = '';
let projectPath = '';
let workspaceDir = '';
let initialized = false;
let currentTaskId: string | null = null;
let cancelRequested = false;
let orphanHandled = false;

// pi-agent-core Agent (lazy, kept alive across tasks)
let agent: import('@mariozechner/pi-agent-core').Agent | null = null;

// Pending answers for tool safety questions
const pendingAnswers = new Map<string, (answer: string) => void>();

function send(msg: WorkerToOrchestrator): void {
  sendIPC(process.stdout, msg);
}

function log(message: string): void {
  process.stderr.write(`[worker:${sessionId || 'init'}] ${message}\n`);
}

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  sessionId = msg.sessionId;
  sessionName = msg.sessionName;
  projectPath = msg.projectPath;
  workspaceDir = msg.workspaceDir;

  initialized = true;
  log(`Initialized (project=${projectPath})`);

  send({ type: 'WORKER_READY', sessionId, pid: process.pid });
}

async function createAgent(msg: WorkerInitMessage): Promise<void> {
  const { Agent } = await import('@mariozechner/pi-agent-core');
  const { getModel } = await import('@mariozechner/pi-ai');
  const { loadTools } = await import('../agent-tools/index.js');
  const { loadBotIdentity } = await import('../agents/bot-identity.js');
  const { join } = await import('path');
  const { readFileSync, existsSync } = await import('fs');

  // Load bot-identity
  const agentsDir = join(workspaceDir, 'agents');
  const identityName = msg.botIdentity ?? 'default';
  const identity = loadBotIdentity(agentsDir, identityName);

  // Build system prompt
  const sections: string[] = [];

  if (identity) {
    sections.push(identity.systemPromptBody);
  } else {
    sections.push(`You are MiloBot, a helpful AI coding agent. You are working on tasks for your user remotely.`);
  }

  sections.push(`## Current Session\n- Working directory: ${projectPath}\n- Session: ${sessionName}`);

  sections.push(`## Your Capabilities
You have tools for file operations, shell commands, git, and code search.
You also have access to CLI coding agents (Claude Code, Gemini CLI, Codex CLI) that you can delegate complex multi-step tasks to.
If a destructive action is needed, your tools will ask the user for confirmation.
Always use the notify_user tool to communicate important progress or results to the user.`);

  // Load project context
  const claudeMdPath = join(projectPath, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    sections.push(`## Project Context (CLAUDE.md)\n${claudeMd}`);
  }

  // Load user preferences
  const memoryPath = join(workspaceDir, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    const memory = readFileSync(memoryPath, 'utf-8');
    sections.push(`## User Preferences\n${memory}`);
  }

  const systemPrompt = sections.join('\n\n');

  // Resolve model
  const provider = identity?.model?.provider ?? msg.config.agentProvider ?? 'anthropic';
  const modelId = identity?.model?.id ?? msg.config.agentModel ?? 'claude-sonnet-4-20250514';
  const model = getModel(provider as any, modelId as any);

  // Resolve tool set
  const toolSet = identity?.toolSet ?? msg.config.toolSet ?? 'full';
  const tools = loadTools(toolSet as any, {
    projectPath,
    sendNotification: (message: string) => {
      send({
        type: 'WORKER_PROGRESS',
        taskId: currentTaskId ?? '',
        sessionId,
        message,
      });
    },
  });

  agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
    },
    convertToLlm: (messages) =>
      messages.filter((m) => ['user', 'assistant', 'toolResult'].includes(m.role)),
    transformContext: async (messages) => {
      const maxMessages = 100;
      if (messages.length <= maxMessages) return messages;
      const head = messages.slice(0, 2);
      const tail = messages.slice(-maxMessages + 2);
      return [
        ...head,
        { role: 'user' as const, content: `[Earlier: ${messages.length - maxMessages} messages pruned]`, timestamp: Date.now() },
        ...tail,
      ];
    },
  });

  // Subscribe to events for IPC forwarding
  agent.subscribe((event) => {
    if (!currentTaskId) return;

    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent?.type === 'text_delta') {
          send({
            type: 'WORKER_STREAM_TEXT',
            sessionId,
            taskId: currentTaskId,
            delta: event.assistantMessageEvent.delta,
          });
        }
        break;

      case 'tool_execution_start':
        send({
          type: 'WORKER_TOOL_START',
          sessionId,
          taskId: currentTaskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;

      case 'tool_execution_end':
        send({
          type: 'WORKER_TOOL_END',
          sessionId,
          taskId: currentTaskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          success: !event.result?.isError,
          summary: event.result?.content?.[0]?.type === 'text'
            ? event.result.content[0].text.slice(0, 200)
            : undefined,
        });
        break;
    }
  });

  log(`Agent created (model=${modelId}, tools=${tools.length}, identity=${identityName})`);
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
    // Lazy agent creation on first task
    if (!agent) {
      // We need the init message to create the agent, but it was already consumed.
      // The init config is stored in module-level vars set during handleInit.
      // Re-create the init config from stored state.
      await createAgent({
        type: 'WORKER_INIT',
        sessionId,
        sessionName,
        sessionType: 'bot',
        projectPath,
        workspaceDir,
        botIdentity: initBotIdentity,
        config: initConfig,
      });
    }

    await agent!.prompt(msg.prompt);

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
    } else {
      // Extract final assistant text
      const messages = agent!.state.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      let output = '';
      if (lastAssistant && 'content' in lastAssistant) {
        if (typeof lastAssistant.content === 'string') {
          output = lastAssistant.content;
        } else if (Array.isArray(lastAssistant.content)) {
          output = lastAssistant.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
        }
      }

      send({
        type: 'WORKER_TASK_DONE',
        taskId: msg.taskId,
        sessionId,
        success: true,
        output: output || 'Task completed.',
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
    send({ type: 'WORKER_READY', sessionId, pid: process.pid });
  }
}

async function handleCancel(_msg: WorkerCancelMessage): Promise<void> {
  log(`Cancel requested for task: ${currentTaskId}`);
  cancelRequested = true;

  if (agent) {
    agent.abort();
  }
}

function handleSteer(msg: WorkerSteerMessage): void {
  if (agent) {
    log(`Steering: ${msg.prompt.slice(0, 80)}...`);
    agent.steer({ role: 'user', content: msg.prompt, timestamp: Date.now() });
  }
}

function handleAnswer(msg: WorkerAnswerMessage): void {
  const resolver = pendingAnswers.get(msg.toolCallId);
  if (resolver) {
    resolver(msg.answer);
    pendingAnswers.delete(msg.toolCallId);
  }
}

// Store init config for lazy agent creation
let initBotIdentity: string | undefined;
let initConfig: WorkerInitMessage['config'] = {};

// --- Orphan handling ---

async function writeOrphanAuditLog(content: string): Promise<void> {
  if (!workspaceDir || !sessionId) return;
  try {
    const { getDb } = await import('../db/index.js');
    const { insertSessionMessage } = await import('../db/sessions-db.js');
    const db = getDb(workspaceDir);
    insertSessionMessage(db, sessionId, 'system', content);
  } catch (err) {
    log(`Failed to write orphan audit log: ${err}`);
  }
}

async function handleOrphanState(): Promise<void> {
  if (orphanHandled) return;
  orphanHandled = true;

  log('Orchestrator connection lost (stdin EOF). Entering orphan state.');
  await writeOrphanAuditLog('Orchestrator connection lost. Worker entering orphan state.');
  sendNotification(
    'MiloBot Worker Orphaned',
    `Session "${sessionName || sessionId}" lost orchestrator connection.`,
  );

  if (!currentTaskId && !agent?.state.isStreaming) {
    log('No task running. Exiting.');
    await writeOrphanAuditLog('No task running. Exiting.');
    process.exit(1);
    return;
  }

  log(`Task running (${currentTaskId}). Waiting up to 30 minutes.`);
  await writeOrphanAuditLog(`Task running (${currentTaskId}). Waiting up to 30 minutes.`);

  const deadline = Date.now() + ORPHAN_TIMEOUT_MS;
  const poll = setInterval(async () => {
    if (!currentTaskId && !agent?.state.isStreaming) {
      clearInterval(poll);
      log('Task completed. Exiting orphaned worker.');
      await writeOrphanAuditLog('Task completed. Exiting orphaned worker.');
      process.exit(0);
    }
    if (Date.now() > deadline) {
      clearInterval(poll);
      log('Orphan timeout reached (30 min). Force exiting.');
      await writeOrphanAuditLog('Orphan timeout reached. Force exiting.');
      process.exit(1);
    }
  }, 5000);
}

function monitorStdinEOF(): void {
  process.stdin.on('end', () => {
    handleOrphanState();
  });
}

// --- Main loop ---

async function main(): Promise<void> {
  log('Worker process starting...');
  monitorStdinEOF();

  for await (const msg of readIPC(process.stdin)) {
    switch (msg.type) {
      case 'WORKER_INIT':
        initBotIdentity = msg.botIdentity;
        initConfig = msg.config;
        await handleInit(msg);
        break;
      case 'WORKER_TASK':
        await handleTask(msg);
        break;
      case 'WORKER_CANCEL':
        await handleCancel(msg);
        break;
      case 'WORKER_STEER':
        handleSteer(msg);
        break;
      case 'WORKER_ANSWER':
        handleAnswer(msg);
        break;
      case 'WORKER_CLOSE':
        log('Close requested, exiting...');
        process.exit(0);
        break;
      default:
        log(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  await handleOrphanState();
}

main().catch((err) => {
  process.stderr.write(`[worker] Fatal error: ${err}\n`);
  process.exit(1);
});
```

**Step 2: Typecheck**

```bash
pnpm typecheck
```

Fix any type errors. The main risk is pi-agent-core event types — check the actual types exported by the library and adjust the event handler accordingly.

**Step 3: Commit**

```bash
git add app/orchestrator/worker.ts
git commit -m "feat: rewrite worker to use pi-agent-core Agent"
```

---

### Task 9: Update Session Actor Manager

**Files:**
- Modify: `app/orchestrator/session-actor.ts:28-36` (options interface)
- Modify: `app/orchestrator/session-actor.ts:251-263` (WORKER_INIT message)
- Modify: `app/orchestrator/session-actor.ts:308-349` (handleWorkerMessage)

**Step 1: Update SessionActorManagerOptions**

In `app/orchestrator/session-actor.ts`, update the options interface (line 28-36) to replace `anthropicApiKey` and `aiModel` with new config:

```typescript
export interface SessionActorManagerOptions {
  workspaceDir: string;
  workerScript: string;
  agentProvider?: string;
  agentModel?: string;
  utilityProvider?: string;
  utilityModel?: string;
  logger: Logger;
  onWorkerEvent: (sessionId: string, event: WorkerToOrchestrator) => void;
  onWorkerStateChange?: (sessionId: string, pid: number | null, state: WorkerState) => void;
}
```

**Step 2: Update WORKER_INIT construction**

In `spawnWorker` (around line 252-263), update the init message:

```typescript
sendIPC(child.stdin!, {
  type: 'WORKER_INIT',
  sessionId: actor.sessionId,
  sessionName: actor.sessionName,
  sessionType: actor.sessionType,
  projectPath: actor.projectPath,
  workspaceDir: this.options.workspaceDir,
  botIdentity: (actor as any).botIdentity,
  config: {
    agentProvider: this.options.agentProvider,
    agentModel: this.options.agentModel,
    utilityProvider: this.options.utilityProvider,
    utilityModel: this.options.utilityModel,
  },
});
```

**Step 3: Add botIdentity to SessionActor type**

In `app/orchestrator/session-types.ts`, add to `SessionActor` interface (line 47-59):

```typescript
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
  botIdentity?: string;  // NEW
  createdAt: Date;
  updatedAt: Date;
}
```

**Step 4: Update getOrCreate to accept botIdentity**

In `session-actor.ts`, update `getOrCreate` meta parameter (line 51-55):

```typescript
async getOrCreate(sessionId: string, meta: {
  sessionName: string;
  sessionType: 'chat' | 'bot';
  projectPath: string;
  botIdentity?: string;
}): Promise<SessionActor> {
```

And set it on actor creation (around line 59-72):

```typescript
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
    botIdentity: meta.botIdentity,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  this.actors.set(sessionId, actor);
}
```

**Step 5: Handle new IPC events in handleWorkerMessage**

In `handleWorkerMessage` (line 308-349), add cases for new event types:

```typescript
case 'WORKER_STREAM_TEXT':
case 'WORKER_TOOL_START':
case 'WORKER_TOOL_END':
case 'WORKER_QUESTION':
  // Forward to orchestrator for publishing
  break;
```

These just fall through to the `this.options.onWorkerEvent()` call at the bottom which already forwards all events.

**Step 6: Add sendSteer method**

Add a public method to forward steering messages:

```typescript
/**
 * Send a steering message to a running session's worker.
 */
steer(sessionId: string, prompt: string): void {
  const actor = this.actors.get(sessionId);
  if (!actor || !actor.worker || actor.worker.state !== 'busy') return;
  this.sendToWorker(actor, { type: 'WORKER_STEER', prompt });
}

/**
 * Send an answer to a worker's pending question.
 */
answer(sessionId: string, toolCallId: string, answerText: string): void {
  const actor = this.actors.get(sessionId);
  if (!actor || !actor.worker) return;
  this.sendToWorker(actor, { type: 'WORKER_ANSWER', toolCallId, answer: answerText });
}
```

**Step 7: Typecheck**

```bash
pnpm typecheck
```

**Step 8: Commit**

```bash
git add app/orchestrator/session-actor.ts app/orchestrator/session-types.ts
git commit -m "feat: update session-actor for bot-identity, steering, and new IPC"
```

---

### Task 10: Update Orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts:96-108` (actor manager creation)
- Modify: `app/orchestrator/orchestrator.ts:354-415` (handleWorkerEvent)

**Step 1: Update actor manager creation**

In `orchestrator.ts`, update the `SessionActorManager` construction (around line 98-108):

```typescript
this.actorManager = new SessionActorManager({
  workspaceDir: this.config.workspace.baseDir,
  workerScript,
  agentProvider: this.config.ai.agent.provider,
  agentModel: this.config.ai.agent.model,
  utilityProvider: this.config.ai.utility.provider,
  utilityModel: this.config.ai.utility.model,
  logger: this.logger,
  onWorkerEvent: this.handleWorkerEvent.bind(this),
  onWorkerStateChange: (sessionId: string, pid: number | null, state: WorkerState) => {
    updateWorkerState(this.db, sessionId, pid, state);
  },
});
```

**Step 2: Handle new worker events**

In `handleWorkerEvent` (around line 354-415), add cases for new event types:

```typescript
case 'WORKER_STREAM_TEXT':
  // Debounce and publish to user (batch text deltas)
  this.publishEvent(sessionId, event.delta);
  break;

case 'WORKER_TOOL_START':
  this.publishEvent(sessionId, `Using ${event.toolName}...`);
  break;

case 'WORKER_TOOL_END':
  if (event.summary) {
    this.publishEvent(sessionId, `${event.toolName}: ${event.summary}`);
  }
  break;

case 'WORKER_QUESTION': {
  // Forward question to user
  const questionContent = event.options
    ? `${event.question}\nOptions: ${event.options.join(', ')}`
    : event.question;
  this.publishEvent(sessionId, questionContent);
  enqueueOutbox(this.db, 'send_message', {
    sessionId,
    content: questionContent,
  }, sessionId);
  updateSessionStatus(this.db, sessionId, 'OPEN_WAITING_USER');
  break;
}
```

**Step 3: Add steering in routeMessage**

In `routeMessage` (around line 286-331), before enqueuing, check if the session is currently running and steer instead:

```typescript
// If session is running, steer instead of queueing
const actor = this.actorManager.get(message.sessionId);
if (actor && actor.status === 'OPEN_RUNNING' && workItemType === 'USER_MESSAGE') {
  this.actorManager.steer(message.sessionId, message.content);
  this.logger.verbose(`Steered running session ${message.sessionId}`);
  return;
}
```

Add this check before the `getOrCreate` call.

**Step 4: Typecheck**

```bash
pnpm typecheck
```

**Step 5: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat: update orchestrator for new IPC events and steering"
```

---

### Task 11: Update Intent Parser for Bot-Identity Detection

**Files:**
- Modify: `app/intent/patterns.ts`
- Modify: `app/intent/parser.ts`

**Step 1: Add bot-identity pattern**

In `app/intent/patterns.ts`, add after the `GREETING_PATTERNS` (around line 154):

```typescript
/**
 * Bot-identity mention pattern: @name at start of message
 */
const BOT_IDENTITY_PATTERN = /^@(?<botIdentity>[\w-]+)\s+(?<task>.+)$/i;

/**
 * Check if content mentions a bot-identity via @name syntax.
 * Returns the identity name and remaining task, or null.
 */
export function matchBotIdentity(content: string): {
  botIdentity: string;
  task: string;
} | null {
  const match = content.trim().match(BOT_IDENTITY_PATTERN);
  if (match?.groups) {
    return {
      botIdentity: match.groups.botIdentity,
      task: match.groups.task.trim(),
    };
  }
  return null;
}
```

**Step 2: Update ParsedIntent type**

In `app/intent/types.ts` (or `app/shared/types.ts` wherever `ParsedIntent` is defined), add `botIdentity` field:

```typescript
export interface ParsedIntent {
  type: 'open_session' | 'send_message' | 'question' | 'greeting' | 'unknown';
  // ... existing fields ...
  botIdentity?: string;  // NEW: bot-identity name from @mention
}
```

**Step 3: Use in parser.ts**

In `app/intent/parser.ts`, import `matchBotIdentity` and use it before pattern matching (around line 31, after the `sessionId` check):

```typescript
// Case 1.5: Check for @bot-identity mention
const identityMatch = matchBotIdentity(content);
if (identityMatch) {
  const sessionName = generateSessionName(identityMatch.task);
  logger.verbose(`  Bot-identity detected: @${identityMatch.botIdentity}`);
  return {
    type: 'open_session',
    sessionName,
    taskDescription: identityMatch.task,
    botIdentity: identityMatch.botIdentity,
    confidence: 0.95,
    raw: content,
  };
}
```

**Step 4: Add test**

Add to `__tests__/intent/parser.test.ts`:

```typescript
it('detects @bot-identity mentions', () => {
  const message = createMessage('@matt design the API for billing');
  const result = parseIntent(message, mockConfig);
  expect(result.type).toBe('open_session');
  expect(result.botIdentity).toBe('matt');
  expect(result.taskDescription).toBe('design the API for billing');
});

it('handles @bot-identity with task verbs', () => {
  const message = createMessage('@reviewer review the auth module');
  const result = parseIntent(message, mockConfig);
  expect(result.type).toBe('open_session');
  expect(result.botIdentity).toBe('reviewer');
});
```

**Step 5: Run tests**

```bash
pnpm test -- __tests__/intent/parser.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add app/intent/ __tests__/intent/
git commit -m "feat: add @bot-identity detection to intent parser"
```

---

### Task 12: Delete Old Claude Code Bridge

**Files:**
- Delete: `app/claude-code/bridge.ts`
- Delete: `app/claude-code/types.ts`
- Delete: `app/claude-code/index.ts`

**Step 1: Check for remaining imports**

Search for any file still importing from `claude-code/`:

```bash
grep -rn "from.*claude-code" app/ --include="*.ts" | grep -v node_modules | grep -v agent-tools
```

If any imports remain outside of `agent-tools/cli-agent-tools.ts`, update them.

**Step 2: Delete the files**

```bash
rm app/claude-code/bridge.ts app/claude-code/types.ts app/claude-code/index.ts
rmdir app/claude-code
```

**Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS (no remaining references)

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove old claude-code bridge (replaced by agent-tools)"
```

---

### Task 13: Wire Up Orchestrator Route to Pass Bot-Identity

**Files:**
- Modify: `app/orchestrator/orchestrator.ts` (routeMessage)

**Step 1: Update routeMessage to pass botIdentity through**

The `routeMessage` method needs to extract `botIdentity` from the intent parser result and pass it to `getOrCreate`. This requires running the intent parser in the orchestrator (currently it's not used there — the orchestrator just routes by session).

In `routeMessage`, after deriving the work item type, pass bot-identity if available. The simplest approach: check message content for `@name` pattern inline:

```typescript
import { matchBotIdentity } from '../intent/patterns.js';

// Inside routeMessage, before getOrCreate:
const identityMatch = matchBotIdentity(message.content);
const botIdentity = identityMatch?.botIdentity;

const actor = await this.actorManager.getOrCreate(message.sessionId, {
  sessionName: message.sessionName ?? message.sessionId,
  sessionType: (message.sessionType as 'chat' | 'bot') || 'bot',
  projectPath,
  botIdentity,
});
```

**Step 2: Typecheck**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat: pass bot-identity from message to session actor"
```

---

### Task 14: Create Default Bot-Identity Template

**Files:**
- Create: `workspace-template/agents/default.md`

**Step 1: Create the default bot-identity file**

Create `workspace-template/agents/default.md`:

```markdown
---
name: Milo
role: AI Coding Assistant
toolSet: full
---

# Milo -- AI Coding Assistant

You are Milo, a capable AI coding assistant controlled remotely by your user.
You help with software development tasks including writing code, debugging,
refactoring, research, and project management.

## Communication Style
- Be concise and action-oriented
- Show your work: explain what you're doing and why
- Use the notify_user tool to keep the user informed of progress
- Ask for clarification when requirements are ambiguous

## Work Approach
- Read existing code before making changes
- Make minimal, focused changes
- Test your work when possible
- Commit frequently with clear messages
```

**Step 2: Commit**

```bash
git add workspace-template/agents/
git commit -m "feat: add default Milo bot-identity template"
```

---

### Task 15: Full Integration Test

**Step 1: Typecheck the entire project**

```bash
pnpm typecheck
```

Expected: PASS with no errors.

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: All existing + new tests pass. Fix any failures.

**Step 3: Build**

```bash
pnpm build
```

Expected: PASS — tsup bundles successfully.

**Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from pi-agent-core refactor"
```

---

### Task 16: Update Documentation

**Files:**
- Modify: `CLAUDE.md` (in `milo-bot/agent/`)

**Step 1: Update CLAUDE.md architecture section**

Update the "Architecture" and "Source Layout" sections to reflect:
- New `app/agent-tools/` directory
- New `app/agents/` directory (bot-identity)
- Removed `app/claude-code/` directory
- Updated dependency list (`@anthropic-ai/sdk` removed, pi-agent-core/pi-ai added)
- Updated config schema documentation (ai.agent, ai.utility)

**Step 2: Update environment variables section**

Replace `ANTHROPIC_API_KEY` description with note about pi-ai's per-provider env vars. pi-ai reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc. automatically.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for pi-agent-core architecture"
```
