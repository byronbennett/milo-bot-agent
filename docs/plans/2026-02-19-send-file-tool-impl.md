# Send File Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `send_file` agent tool that reads a text file and delivers its contents to the user's browser via PubNub, using a new `fileContents` field on the `PubNubEventMessage` format.

**Architecture:** New IPC message type `WORKER_FILE_SEND` flows from worker → orchestrator → PubNub adapter. A new `sendFile` callback on `ToolContext` lets any tool (not just `send_file`) send files. The tool validates text extensions and enforces a 20KB size limit.

**Tech Stack:** TypeScript, pi-agent-core AgentTool, Typebox schemas, JSON Lines IPC, PubNub

---

### Task 1: Add `WORKER_FILE_SEND` IPC message type

**Files:**
- Modify: `app/orchestrator/ipc-types.ts`

**Step 1: Add the `WorkerFileSendMessage` interface**

Add this interface after `WorkerProgressMessage` (after line 127):

```typescript
export interface WorkerFileSendMessage {
  type: 'WORKER_FILE_SEND';
  taskId: string;
  sessionId: string;
  filename: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mimeType: string;
  sizeBytes: number;
}
```

**Step 2: Add to `WorkerToOrchestrator` union**

Add `| WorkerFileSendMessage` to the union type (after `WorkerProgressMessage` in the union, around line 184).

**Step 3: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS (no new errors)

**Step 4: Commit**

```bash
git add app/orchestrator/ipc-types.ts
git commit -m "feat(ipc): add WORKER_FILE_SEND message type"
```

---

### Task 2: Add `file_send` event type and `fileContents` field to PubNub types

**Files:**
- Modify: `app/messaging/pubnub-types.ts`

**Step 1: Add `'file_send'` to `PubNubEventType` union**

Add `| 'file_send'` after `| 'form_request'` (line 55), before `| 'error'`.

**Step 2: Add `fileContents` field to `PubNubEventMessage`**

Add this field after `formDefinition` (after line 101):

```typescript
  /** File contents for file_send events */
  fileContents?: {
    filename: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mimeType: string;
    sizeBytes: number;
  };
```

**Step 3: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add app/messaging/pubnub-types.ts
git commit -m "feat(pubnub): add file_send event type and fileContents field"
```

---

### Task 3: Add `sendFile` callback to `ToolContext`

**Files:**
- Modify: `app/agent-tools/index.ts`

**Step 1: Add `sendFile` to `ToolContext` interface**

Add this after the `sendIpcEvent` field (after line 43):

```typescript
  sendFile?: (opts: {
    filename: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mimeType: string;
    sizeBytes: number;
  }) => void;
```

**Step 2: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/agent-tools/index.ts
git commit -m "feat(tools): add sendFile callback to ToolContext"
```

---

### Task 4: Wire `sendFile` in the worker process

**Files:**
- Modify: `app/orchestrator/worker.ts`

**Step 1: Add `sendFile` callback to the tool context in `createAgent()`**

In `worker.ts`, inside `createAgent()` where `loadTools` is called (around line 169-276), add the `sendFile` callback to the tools context object. Place it after `sendNotification` (after line 183):

```typescript
    sendFile: (opts) => {
      send({
        type: 'WORKER_FILE_SEND',
        taskId: currentTaskId ?? '',
        sessionId,
        ...opts,
      });
    },
```

**Step 2: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/orchestrator/worker.ts
git commit -m "feat(worker): wire sendFile callback for WORKER_FILE_SEND IPC"
```

---

### Task 5: Handle `WORKER_FILE_SEND` in the orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`

**Step 1: Add `WORKER_FILE_SEND` case to `handleWorkerEvent`**

In `handleWorkerEvent()` (starts at line 744), add a new case after the `WORKER_PROGRESS` case (after line 808):

```typescript
      case 'WORKER_FILE_SEND':
        if (this.pubnubAdapter?.isConnected) {
          this.pubnubAdapter.publishEvent({
            type: 'file_send',
            agentId: this.agentId,
            sessionId,
            content: `Sent file: ${event.filename}`,
            fileContents: {
              filename: event.filename,
              content: event.content,
              encoding: event.encoding,
              mimeType: event.mimeType,
              sizeBytes: event.sizeBytes,
            },
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            this.logger.warn('PubNub file_send publish failed:', err);
          });
        }
        break;
```

**Step 2: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): handle WORKER_FILE_SEND and publish file_send events"
```

---

### Task 6: Create the `send_file` tool — tests first

**Files:**
- Create: `__tests__/agent-tools/send-file-tool.test.ts`

**Step 1: Write the test file**

```typescript
import { createSendFileTool, TEXT_EXTENSIONS, MAX_FILE_SIZE, getMimeType } from '../../app/agent-tools/send-file-tool.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), 'send-file-tool-test');

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('createSendFileTool', () => {
  it('returns a tool with correct name and label', () => {
    const tool = createSendFileTool({ sendFile: () => {} });
    expect(tool.name).toBe('send_file');
    expect(tool.label).toBe('Send File');
  });
});

describe('TEXT_EXTENSIONS', () => {
  it('includes common text file extensions', () => {
    expect(TEXT_EXTENSIONS).toContain('.txt');
    expect(TEXT_EXTENSIONS).toContain('.json');
    expect(TEXT_EXTENSIONS).toContain('.html');
    expect(TEXT_EXTENSIONS).toContain('.csv');
    expect(TEXT_EXTENSIONS).toContain('.ts');
    expect(TEXT_EXTENSIONS).toContain('.py');
  });

  it('does not include binary extensions', () => {
    expect(TEXT_EXTENSIONS).not.toContain('.png');
    expect(TEXT_EXTENSIONS).not.toContain('.jpg');
    expect(TEXT_EXTENSIONS).not.toContain('.exe');
    expect(TEXT_EXTENSIONS).not.toContain('.zip');
  });
});

describe('getMimeType', () => {
  it('returns correct mime types for known extensions', () => {
    expect(getMimeType('.json')).toBe('application/json');
    expect(getMimeType('.html')).toBe('text/html');
    expect(getMimeType('.txt')).toBe('text/plain');
    expect(getMimeType('.csv')).toBe('text/csv');
    expect(getMimeType('.ts')).toBe('text/x-typescript');
    expect(getMimeType('.xml')).toBe('application/xml');
  });

  it('returns text/plain for unknown extensions', () => {
    expect(getMimeType('.unknown')).toBe('text/plain');
  });
});

describe('execute', () => {
  it('sends file contents via sendFile callback', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'Hello, world!');

    let captured: any = null;
    const tool = createSendFileTool({
      sendFile: (opts) => { captured = opts; },
    });

    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('Sent');
    expect(captured).not.toBeNull();
    expect(captured.filename).toBe('test.txt');
    expect(captured.content).toBe('Hello, world!');
    expect(captured.encoding).toBe('utf-8');
    expect(captured.mimeType).toBe('text/plain');
    expect(captured.sizeBytes).toBe(13);
  });

  it('rejects non-text file extensions', async () => {
    const filePath = join(testDir, 'test.png');
    writeFileSync(filePath, 'not a real image');

    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('not a supported text file');
  });

  it('rejects files exceeding size limit', async () => {
    const filePath = join(testDir, 'big.txt');
    writeFileSync(filePath, 'x'.repeat(21000));

    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('exceeds');
  });

  it('rejects nonexistent files', async () => {
    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath: '/tmp/nonexistent-file.txt' });
    expect(result.content[0].text).toContain('not found');
  });

  it('sends JSON files with correct mime type', async () => {
    const filePath = join(testDir, 'data.json');
    writeFileSync(filePath, '{"key": "value"}');

    let captured: any = null;
    const tool = createSendFileTool({
      sendFile: (opts) => { captured = opts; },
    });

    await tool.execute('call-1', { filePath });
    expect(captured.mimeType).toBe('application/json');
    expect(captured.filename).toBe('data.json');
  });

  it('handles files with no extension by rejecting them', async () => {
    const filePath = join(testDir, 'noext');
    writeFileSync(filePath, 'some content');

    const tool = createSendFileTool({ sendFile: () => {} });
    const result = await tool.execute('call-1', { filePath });
    expect(result.content[0].text).toContain('not a supported text file');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/send-file-tool.test.ts`
Expected: FAIL — module `../../app/agent-tools/send-file-tool.js` not found

**Step 3: Commit the test file**

```bash
git add __tests__/agent-tools/send-file-tool.test.ts
git commit -m "test(send-file): add failing tests for send_file tool"
```

---

### Task 7: Implement the `send_file` tool

**Files:**
- Create: `app/agent-tools/send-file-tool.ts`

**Step 1: Write the implementation**

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { readFileSync, existsSync, statSync } from 'fs';
import { basename, extname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendFileToolDeps {
  sendFile: (opts: {
    filename: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mimeType: string;
    sizeBytes: number;
  }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (20KB — leaves room for base64 + JSON envelope within PubNub 32KB limit) */
export const MAX_FILE_SIZE = 20 * 1024;

/** Allowed text file extensions */
export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.xml', '.html', '.htm', '.css',
  '.js', '.ts', '.jsx', '.tsx', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log',
  '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.svg',
]);

/** Map file extensions to MIME types */
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.jsx': 'text/javascript',
  '.tsx': 'text/x-typescript',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/x-toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.log': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.sql': 'text/x-sql',
  '.graphql': 'text/x-graphql',
  '.env': 'text/plain',
  '.gitignore': 'text/plain',
  '.dockerfile': 'text/x-dockerfile',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

export function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'text/plain';
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const SendFileParams = Type.Object({
  filePath: Type.String({ description: 'Absolute path to the text file to send to the user' }),
});

export function createSendFileTool(deps: SendFileToolDeps): AgentTool<typeof SendFileParams> {
  return {
    name: 'send_file',
    label: 'Send File',
    description:
      'Send the contents of a text file to the user. ' +
      'Supports common text formats: source code, config files, JSON, XML, HTML, CSV, Markdown, etc. ' +
      'Maximum file size: 20KB. Binary files are not supported.',
    parameters: SendFileParams,
    execute: async (_toolCallId, params) => {
      const { filePath } = params;

      // Validate file exists
      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: `File not found: ${filePath}` }],
          details: { error: 'not_found' },
        };
      }

      // Validate extension
      const ext = extname(filePath).toLowerCase();
      if (!ext || !TEXT_EXTENSIONS.has(ext)) {
        const supported = [...TEXT_EXTENSIONS].sort().join(', ');
        return {
          content: [{ type: 'text' as const, text: `"${basename(filePath)}" is not a supported text file type.\n\nSupported extensions: ${supported}` }],
          details: { error: 'unsupported_type' },
        };
      }

      // Validate size
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        const sizeKB = (stat.size / 1024).toFixed(1);
        const maxKB = (MAX_FILE_SIZE / 1024).toFixed(0);
        return {
          content: [{ type: 'text' as const, text: `File exceeds the ${maxKB}KB size limit (${sizeKB}KB). Consider sending a smaller file or a relevant excerpt.` }],
          details: { error: 'too_large', sizeBytes: stat.size },
        };
      }

      // Read and encode
      const buffer = readFileSync(filePath);
      let content: string;
      let encoding: 'utf-8' | 'base64';

      try {
        // Try UTF-8 decode — check for replacement characters indicating invalid UTF-8
        const text = buffer.toString('utf-8');
        if (text.includes('\uFFFD')) {
          content = buffer.toString('base64');
          encoding = 'base64';
        } else {
          content = text;
          encoding = 'utf-8';
        }
      } catch {
        content = buffer.toString('base64');
        encoding = 'base64';
      }

      const filename = basename(filePath);
      const mimeType = getMimeType(ext);

      // Send via IPC → PubNub
      deps.sendFile({
        filename,
        content,
        encoding,
        mimeType,
        sizeBytes: stat.size,
      });

      return {
        content: [{ type: 'text' as const, text: `Sent "${filename}" to the user (${(stat.size / 1024).toFixed(1)}KB, ${mimeType}).` }],
        details: { filename, mimeType, sizeBytes: stat.size, encoding },
      };
    },
  };
}
```

**Step 2: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/send-file-tool.test.ts`
Expected: PASS — all 9 tests pass

**Step 3: Commit**

```bash
git add app/agent-tools/send-file-tool.ts
git commit -m "feat(send-file): implement send_file tool with text validation and size limit"
```

---

### Task 8: Register `send_file` in `loadTools`

**Files:**
- Modify: `app/agent-tools/index.ts`

**Step 1: Add import for `createSendFileTool`**

Add after the `createUsageTool` import (line 15):

```typescript
import { createSendFileTool } from './send-file-tool.js';
```

**Step 2: Create `sendFileTools` array in `loadTools()`**

Add after the `usageTools` definition (after line 70):

```typescript
  const sendFileTools = ctx.sendFile
    ? [createSendFileTool({ sendFile: ctx.sendFile })]
    : [];
```

**Step 3: Add `...sendFileTools` to all tool set cases**

Add `...sendFileTools` next to `...usageTools` in each case:

- `'full'` case (line 74): add `...sendFileTools` at the end
- `'minimal'` case (line 78): add `...sendFileTools` at the end
- `default` case inside array filter (line 81): add `...sendFileTools` to the `all` array
- `default` final return (line 84): add `...sendFileTools` at the end

**Step 4: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/index.ts
git commit -m "feat(tools): register send_file in loadTools for full and minimal sets"
```

---

### Task 9: Add `send_file` registration tests to `load-tools.test.ts`

**Files:**
- Modify: `__tests__/agent-tools/load-tools.test.ts`

**Step 1: Add tests for `send_file` registration**

Add these tests after the existing `check_usage` tests (after line 57):

```typescript
  it('full set includes send_file when sendFile is provided', () => {
    const ctxWithSendFile = {
      ...ctx,
      sendFile: () => {},
    };
    const tools = loadTools('full', ctxWithSendFile);
    const names = tools.map((t) => t.name);
    expect(names).toContain('send_file');
  });

  it('minimal set includes send_file when sendFile is provided', () => {
    const ctxWithSendFile = {
      ...ctx,
      sendFile: () => {},
    };
    const tools = loadTools('minimal', ctxWithSendFile);
    const names = tools.map((t) => t.name);
    expect(names).toContain('send_file');
  });

  it('send_file is not included when sendFile is not provided', () => {
    const tools = loadTools('full', ctx);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('send_file');
  });
```

**Step 2: Run all tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/load-tools.test.ts __tests__/agent-tools/send-file-tool.test.ts`
Expected: PASS — all tests pass

**Step 3: Commit**

```bash
git add __tests__/agent-tools/load-tools.test.ts
git commit -m "test(tools): add send_file registration tests"
```

---

### Task 10: Run full test suite and verify build

**Files:** None (verification only)

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (130+ existing + ~12 new)

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — no errors

**Step 3: Run build**

Run: `pnpm build`
Expected: PASS — clean build
