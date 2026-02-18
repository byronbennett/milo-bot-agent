# Version Tracking & Update Checking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track the agent's current version (git SHA or npm version), periodically check GitHub/npm for newer versions, notify users, and report status to the web app API.

**Architecture:** Extend `updater.ts` with version detection and remote check functions. Add an hourly timer in the orchestrator. Report version status to the web app via a new `POST /api/agent/update-status` endpoint. Include version info in the `/status` report.

**Tech Stack:** GitHub REST API (unauthenticated, public repo), npm registry API, native `fetch()`.

---

### Task 1: Add `UpdateStatusRequest` type to shared API types

**Files:**
- Modify: `app/shared/api-types.ts`

**Step 1: Add the interface**

In `app/shared/api-types.ts`, add a new section after the Skills API section (after line 213):

```typescript
// ============================================================================
// Update Status API
// ============================================================================

export interface UpdateStatusRequest {
  version: string;
  latestVersion: string;
  needsUpdate: boolean;
}

export interface UpdateStatusResponse {
  ok: boolean;
}
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/shared/api-types.ts
git commit -m "feat: add UpdateStatusRequest/Response API types"
```

---

### Task 2: Add `sendUpdateStatus()` to WebAppAdapter

**Files:**
- Modify: `app/messaging/webapp-adapter.ts`

**Step 1: Add the method**

Import the new type at the top of `app/messaging/webapp-adapter.ts` (line 2):

```typescript
import type { HeartbeatResponse, PendingMessage, UpdateStatusRequest, UpdateStatusResponse } from '../shared';
```

Then add the method after `syncModels` (after line 117):

```typescript
/**
 * Report agent version and update status to web app
 */
async sendUpdateStatus(status: UpdateStatusRequest): Promise<void> {
  await this.request<UpdateStatusResponse>('POST', '/agent/update-status', status);
}
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/messaging/webapp-adapter.ts
git commit -m "feat: add sendUpdateStatus method to WebAppAdapter"
```

---

### Task 3: Add version detection functions to updater.ts

**Files:**
- Modify: `app/orchestrator/updater.ts`
- Modify: `__tests__/orchestrator/updater.test.ts`

**Step 1: Write failing tests**

Add to `__tests__/orchestrator/updater.test.ts`:

```typescript
import { detectInstallMethod, getPackageRoot, getCurrentVersion, getLatestVersion } from '../../app/orchestrator/updater.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// ... keep existing tests ...

describe('getCurrentVersion', () => {
  it('returns git SHA for git installs', () => {
    // Use the actual repo (which is a git repo)
    const root = getPackageRoot();
    const version = getCurrentVersion(root, 'git');
    expect(version).toMatch(/^[a-f0-9]{7,}$/);
  });

  it('returns package.json version for npm installs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'milo-updater-'));
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const version = getCurrentVersion(tmp, 'npm');
    expect(version).toBe('1.2.3');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/orchestrator/updater.test.ts -v`
Expected: FAIL — `getCurrentVersion` not exported

**Step 3: Implement `getCurrentVersion` and `getLatestVersion`**

Add to `app/orchestrator/updater.ts`, after the existing `runUpdate` function. Also add `readFileSync` to the `fs` import:

```typescript
import { existsSync, readFileSync } from 'fs';
```

Then add the new functions:

```typescript
const GITHUB_REPO = 'byronbennett/milo-bot-agent';
const NPM_PACKAGE = 'milo-bot-agent';
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export { UPDATE_CHECK_INTERVAL_MS };

/**
 * Get the current version of the agent.
 * Git installs: short commit SHA. npm installs: package.json version.
 */
export function getCurrentVersion(packageRoot: string, method: InstallMethod): string {
  if (method === 'git') {
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  // npm: read version from package.json
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Check the remote for the latest version.
 * Git: GitHub API for latest commit on master. npm: npm registry.
 */
export async function getLatestVersion(method: InstallMethod): Promise<string> {
  try {
    if (method === 'git') {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits/master`,
        {
          headers: { Accept: 'application/vnd.github.v3+json' },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) return 'unknown';
      const data = await res.json() as { sha: string };
      return data.sha.slice(0, 7);
    }

    // npm registry
    const res = await fetch(
      `https://registry.npmjs.org/${NPM_PACKAGE}/latest`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return 'unknown';
    const data = await res.json() as { version: string };
    return data.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/orchestrator/updater.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add app/orchestrator/updater.ts __tests__/orchestrator/updater.test.ts
git commit -m "feat: add getCurrentVersion and getLatestVersion to updater"
```

---

### Task 4: Integrate update checking into orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts`

This is the main wiring task. Four changes:

**Step 1: Add imports**

Update the updater import (around line 36) to include the new functions:

```typescript
import { getPackageRoot, detectInstallMethod, runUpdate, getCurrentVersion, getLatestVersion, UPDATE_CHECK_INTERVAL_MS } from './updater.js';
```

**Step 2: Add version state fields**

Add new private fields to the `Orchestrator` class (after `agentId` around line 69):

```typescript
private currentVersion: string = 'unknown';
private latestVersion: string = 'unknown';
private needsUpdate = false;
private installMethod: InstallMethod = 'git';
private updateCheckTimer: NodeJS.Timeout | null = null;
```

Also import `InstallMethod` type:

```typescript
import { getPackageRoot, detectInstallMethod, runUpdate, getCurrentVersion, getLatestVersion, UPDATE_CHECK_INTERVAL_MS, type InstallMethod } from './updater.js';
```

**Step 3: Initialize version on startup and start timer**

In the `start()` method, after the orchestrator is fully started (after `this.isRunning = true` around line 185), add:

```typescript
// 8. Detect version and start update checker
const packageRoot = getPackageRoot();
this.installMethod = detectInstallMethod(packageRoot);
this.currentVersion = getCurrentVersion(packageRoot, this.installMethod);
this.logger.info(`Agent version: ${this.currentVersion} (${this.installMethod})`);

// Run first check immediately, then hourly
this.checkForUpdates();
this.updateCheckTimer = setInterval(() => this.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
```

**Step 4: Clean up timer in `stop()`**

In the `stop()` method, after `if (this.outboxTimer) clearInterval(this.outboxTimer);` (around line 200), add:

```typescript
if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
```

**Step 5: Add `checkForUpdates()` method**

Add a new private method (near `handleSelfUpdate`, around line 385):

```typescript
/**
 * Check for available updates and report status.
 */
private async checkForUpdates(): Promise<void> {
  try {
    const latest = await getLatestVersion(this.installMethod);
    if (latest === 'unknown') {
      this.logger.verbose('Update check: could not determine latest version');
      return;
    }

    const previousNeedsUpdate = this.needsUpdate;
    this.latestVersion = latest;
    this.needsUpdate = this.currentVersion !== latest;

    // Notify once when update becomes available
    if (this.needsUpdate && !previousNeedsUpdate) {
      const msg = `A newer version is available (current: ${this.currentVersion}, latest: ${this.latestVersion})`;
      this.logger.info(msg);
      this.broadcastEvent(msg);
    }

    // Report to web app API
    try {
      await this.restAdapter.sendUpdateStatus({
        version: this.currentVersion,
        latestVersion: this.latestVersion,
        needsUpdate: this.needsUpdate,
      });
    } catch (err) {
      this.logger.verbose('Failed to report update status:', err);
    }
  } catch (err) {
    this.logger.verbose('Update check failed:', err);
  }
}
```

**Step 6: Add version to status report**

In `buildStatusReport()` (around line 1058), add version rows to the status table after the Streaming row:

```typescript
lines.push(`| **Version** | \`${this.currentVersion}\` (${this.installMethod}) |`);
if (this.needsUpdate) {
  lines.push(`| **Latest** | \`${this.latestVersion}\` — **update available** |`);
}
```

**Step 7: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

**Step 8: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat: integrate hourly update checking with version tracking and API reporting"
```

---

### Task 5: End-to-end verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Build**

Run: `pnpm build`
Expected: Builds successfully

**Step 4: Commit any fixes if needed**

```bash
git add -A && git commit -m "chore: fix any lint/type issues from version tracking feature"
```
