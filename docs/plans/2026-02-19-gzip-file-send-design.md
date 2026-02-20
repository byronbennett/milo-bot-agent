# Gzip File Send Compression

**Date:** 2026-02-19
**Status:** Approved

## Problem

The `send_file` tool sends file contents via PubNub for real-time display. Text files (especially HTML, code) frequently exceed PubNub's 32KB message size limit after JSON envelope overhead, causing publish failures. The REST/database path works but real-time delivery fails.

## Solution

Always gzip compress file contents before base64 encoding. A new encoding value `gzip+base64` flows through the entire pipeline. The browser decompresses using the native `DecompressionStream` API.

## Design

### Encoding type

Add `'gzip+base64'` to the encoding union everywhere:
- Agent: `SendFileToolDeps`, `ToolContext.sendFile`, `WorkerFileSendMessage`, `PubNubEventMessage.fileContents`
- Web: `FileAttachment`, Zod schema in `/api/messages/send`

### Agent (send-file-tool.ts)

1. Read file as Buffer
2. `gzipSync(buffer)` → compressed Buffer
3. `compressed.toString('base64')` → string
4. `encoding = 'gzip+base64'`
5. `MAX_FILE_SIZE` increased from 20KB to 30KB

### Browser (FileCard.tsx)

`decodeFileContent` updated to handle `gzip+base64`:
1. `atob()` → `Uint8Array`
2. `DecompressionStream('gzip')` → `ReadableStream`
3. `TextDecoder` → string

Function becomes async since DecompressionStream uses streams.

### Backward compatibility

Old messages in DB with `utf-8` or `base64` encoding still decode correctly. No migration needed.

## Files changed

| File | Change |
|------|--------|
| `agent/app/agent-tools/send-file-tool.ts` | gzip+base64 encoding, MAX_FILE_SIZE → 30KB |
| `agent/app/agent-tools/index.ts` | Update ToolContext encoding type |
| `agent/app/orchestrator/ipc-types.ts` | Update encoding union |
| `agent/app/messaging/pubnub-types.ts` | Update encoding union |
| `agent/__tests__/agent-tools/send-file-tool.test.ts` | Update test expectations |
| `web/shared/types.ts` | Update FileAttachment encoding union |
| `web/app/api/messages/send/route.ts` | Update Zod enum |
| `web/components/chat/FileCard.tsx` | Async gzip+base64 decode |
