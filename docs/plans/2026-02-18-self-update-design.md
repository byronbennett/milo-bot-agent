# Self-Update via `update_milo_agent` UI Action

## Overview

Allow the agent to update itself when it receives a PubNub control message with `ui_action: 'update_milo_agent'`. The agent detects whether it was installed via git clone or npm global, runs the appropriate update commands, and restarts using a configurable restart command.

## Message Handling

The action arrives as a PubNub control message (`type: 'ui_action'`), routed through `handlePubNubControl()` → `handleUiAction()`.

- Extend `PubNubControlMessage` to carry `force?: boolean`
- Add `'update_milo_agent'` case in `handleUiAction()`

## Config Addition

Add an `update` section to `agentConfigSchema`:

```typescript
export const updateConfigSchema = z.object({
  restartCommand: z.string().optional(), // e.g. "pm2 restart milo"
});
```

## Detection Logic

1. Check if `.git` directory exists at the package root (resolved relative to source files)
2. Git present → **git mode**: `git pull && pnpm install && pnpm build`
3. No git → **npm mode**: `npm update -g milo-bot-agent`

## Update Flow

1. Receive `update_milo_agent` action
2. Check for busy session actors
3. If busy and `force !== true` → publish warning listing active sessions
4. If no busy sessions or force is true:
   - Publish "Starting update..." progress
   - Detect install method
   - Run update commands, capturing stdout/stderr
   - On failure → publish error, do not restart (old version keeps running)
   - On success → publish "Update complete, restarting..."
   - If `config.update.restartCommand` set → exec it
   - Otherwise → `this.stop()` + `process.exit(0)`

## Event Communication

Reuse `'agent_message'` PubNub event type for progress/error messages. No new event types needed.

## New Files

- `app/orchestrator/updater.ts` — update logic:
  - `detectInstallMethod()` → `'git' | 'npm'`
  - `runUpdate(method, onProgress)` → shell execution with progress callback
  - `getPackageRoot()` → resolve agent install directory

## Modified Files

| File | Change |
|------|--------|
| `app/config/schema.ts` | Add `updateConfigSchema` with `restartCommand` |
| `app/messaging/pubnub-types.ts` | Add `force?: boolean` to `PubNubControlMessage` |
| `app/orchestrator/orchestrator.ts` | Add `'update_milo_agent'` case in `handleUiAction()` |
| `app/orchestrator/updater.ts` | **New** — update detection + execution |

## Safety

- If update commands fail, the agent continues running the old version
- Active workers are warned about before shutdown (force flag required to override)
- Graceful shutdown flushes outbox and closes DB before exit
