# SET_HEARTBEAT_INTERVAL Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the web client to dynamically change the agent's heartbeat interval via a PubNub control message, persist it to config, and show it in status.

**Architecture:** New `SET_HEARTBEAT_INTERVAL` ui_action handled in orchestrator's `handlePubNubControl()`. Validated interval (> 2, <= 60) is applied to the scheduler, persisted to config.json, and shown in the status report header table.

**Tech Stack:** TypeScript, node-cron (existing), Zod (existing config validation), fs (writeFileSync for config persistence)

---

### Task 1: Add `getIntervalMinutes` getter to HeartbeatScheduler

**Files:**
- Modify: `app/scheduler/heartbeat.ts:87-90`

**Step 1: Add the getter**

In `app/scheduler/heartbeat.ts`, add a getter after the existing `running` getter (line 87):

```typescript
  /**
   * Get current interval in minutes
   */
  get interval(): number {
    return this.intervalMinutes;
  }
```

**Step 2: Verify build**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/scheduler/heartbeat.ts
git commit -m "feat(scheduler): add interval getter to HeartbeatScheduler"
```

---

### Task 2: Add `updateConfigFile` helper to config module

**Files:**
- Modify: `app/config/index.ts`

**Step 1: Add the helper function**

Add at the bottom of `app/config/index.ts`, before the closing of the file:

```typescript
/**
 * Persist a partial config update to the config.json file.
 * Reads the current file, deep-merges the patch, and writes back.
 */
export function updateConfigFile(patch: Record<string, unknown>, configPath?: string): void {
  const path = configPath || getDefaultConfigPath();

  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    current = JSON.parse(readFileSync(path, 'utf-8'));
  }

  // Deep merge one level (handles nested objects like scheduler.*)
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof current[key] === 'object' && current[key] !== null) {
      current[key] = { ...(current[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      current[key] = value;
    }
  }

  writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
}
```

Also add `writeFileSync` to the existing fs import at the top of the file:

```typescript
import { existsSync, readFileSync, watchFile, writeFileSync } from 'fs';
```

**Step 2: Verify build**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/config/index.ts
git commit -m "feat(config): add updateConfigFile helper for persisting config changes"
```

---

### Task 3: Add `SET_HEARTBEAT_INTERVAL` to PubNub control message type

**Files:**
- Modify: `app/messaging/pubnub-types.ts:25-33`

**Step 1: Add intervalMinutes field to PubNubControlMessage**

The existing `PubNubControlMessage` interface (line 25-33) already has generic fields. Add `intervalMinutes` as an optional field:

```typescript
/** Server -> Agent control messages (received on cmd channel) */
export interface PubNubControlMessage {
  type: string;
  ui_action?: string;
  agentId: string;
  sessionId: string;
  sessionName?: string;
  force?: boolean;
  intervalMinutes?: number;
  timestamp: string;
}
```

**Step 2: Verify build**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/messaging/pubnub-types.ts
git commit -m "feat(pubnub): add intervalMinutes to PubNubControlMessage"
```

---

### Task 4: Handle `SET_HEARTBEAT_INTERVAL` in orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts` (handlePubNubControl method ~line 375-389, import updateConfigFile)

**Step 1: Add import for updateConfigFile**

At the top of orchestrator.ts, add `updateConfigFile` to the config import (line 18):

```typescript
import type { AgentConfig } from '../config/index.js';
```

Change to:

```typescript
import { updateConfigFile, type AgentConfig } from '../config/index.js';
```

**Step 2: Add the handler case in handlePubNubControl**

In `handlePubNubControl()`, add a new `else if` branch after the `UPDATE_MILO_AGENT` check (line 378) and before the `check_milo_agent_updates` check (line 379):

```typescript
    } else if (message.ui_action === 'SET_HEARTBEAT_INTERVAL') {
      const interval = message.intervalMinutes;
      if (typeof interval !== 'number' || interval <= 2 || interval > 60) {
        this.logger.warn(`Invalid heartbeat interval: ${interval} (must be > 2 and <= 60)`);
        return;
      }
      this.logger.info(`Setting heartbeat interval to ${interval} minutes`);
      this.config.scheduler.heartbeatIntervalMinutes = interval;
      this.scheduler.setInterval(interval);
      updateConfigFile({ scheduler: { heartbeatIntervalMinutes: interval } });
      this.logger.info(`Heartbeat interval persisted to config.json`);
```

**Step 3: Verify build**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): handle SET_HEARTBEAT_INTERVAL control message"
```

---

### Task 5: Add heartbeat interval to status report

**Files:**
- Modify: `app/orchestrator/orchestrator.ts` (buildStatusReport method ~line 1666)

**Step 1: Add heartbeat interval row to the header table**

In `buildStatusReport()`, after the Version line (line 1666) and before the update-available check (line 1667), add:

```typescript
    lines.push(`| **Heartbeat** | \`${this.config.scheduler.heartbeatIntervalMinutes} min\` |`);
```

**Step 2: Verify build**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(status): show heartbeat interval in status report"
```

---

### Task 6: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md` (agent-level, at `/Users/byron/dev/milo-bot/agent/CLAUDE.md`)

**Step 1: Add SET_HEARTBEAT_INTERVAL to the Control Messages table**

In the "Control Messages (PubNub)" table, add a new row:

```markdown
| `SET_HEARTBEAT_INTERVAL` | Set heartbeat interval. Requires `intervalMinutes` (> 2, <= 60). Persists to config.json |
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add SET_HEARTBEAT_INTERVAL to control messages table"
```
