# Send File Tool Design

## Goal

A new `send_file` agent tool that reads a text file from disk and delivers its contents to the user's chat via PubNub, using a new `fileContents` field on the `PubNubEventMessage` format.

## Data Flow

```
Tool reads file → validates text extension + size
  → calls ctx.sendFile({ filename, content, encoding, mimeType, sizeBytes })
    → worker.ts sends WORKER_FILE_SEND IPC message
      → orchestrator handleWorkerEvent() receives it
        → pubnubAdapter.publishEvent() with fileContents field
          → PubNub evt channel → browser
```

## Changes by Layer

### 1. PubNub Message Format (`pubnub-types.ts`)

Add `'file_send'` to the `PubNubEventType` union.

Add to `PubNubEventMessage`:

```typescript
fileContents?: {
  filename: string;
  content: string;       // raw UTF-8 or base64-encoded
  encoding: 'utf-8' | 'base64';
  mimeType: string;
  sizeBytes: number;     // original file size in bytes
};
```

### 2. IPC Types (`ipc-types.ts`)

New message type:

```typescript
interface WorkerFileSendMessage {
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

Added to the `WorkerToOrchestrator` union.

### 3. ToolContext (`agent-tools/index.ts`)

New optional callback:

```typescript
sendFile?: (opts: {
  filename: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mimeType: string;
  sizeBytes: number;
}) => void;
```

### 4. Worker Wiring (`worker.ts`)

Wire `sendFile` in `createAgent()` tool context:

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

### 5. Orchestrator Handler (`orchestrator.ts`)

Handle `WORKER_FILE_SEND` in `handleWorkerEvent`:

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
    });
  }
  break;
```

### 6. The Tool (`send-file-tool.ts`)

**Parameters:** `filePath` (string, required)

**Text file whitelist:** `.txt`, `.md`, `.json`, `.xml`, `.html`, `.htm`, `.css`, `.js`, `.ts`, `.jsx`, `.tsx`, `.csv`, `.tsv`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.log`, `.sh`, `.bash`, `.zsh`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.sql`, `.graphql`, `.env`, `.gitignore`, `.dockerfile`, `.svg`

**Size limit:** 20KB (20,480 bytes) raw. Leaves headroom for base64 expansion (~27KB) plus JSON envelope (~1KB) within PubNub's 32KB message limit.

**Encoding strategy:**
- Read file as Buffer
- Check size <= 20KB
- Try UTF-8 decode; if valid, use `encoding: 'utf-8'`
- Otherwise base64-encode with `encoding: 'base64'`

**MIME type:** Inferred from extension (e.g., `.json` -> `application/json`, `.txt` -> `text/plain`).

**Dependencies:** `sendFile` callback from `ToolContext`.

### 7. Tool Registration (`agent-tools/index.ts`)

Register in `loadTools()` for `full` and `minimal` tool sets, gated on `ctx.sendFile` being available.

## Constraints

- Only text files (extension whitelist)
- 20KB max file size
- PubNub 32KB message limit
- No binary files
- Fire-and-forget delivery (same as sendNotification — no REST persistence for progress messages)
