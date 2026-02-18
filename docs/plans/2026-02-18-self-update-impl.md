# Self-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the agent to update itself via a PubNub control message (`update_milo_agent`), detecting git vs npm install method, with active-worker safety checks and configurable restart.

**Architecture:** New `updater.ts` module handles detection and execution. Orchestrator routes the control message inline (same pattern as `STATUS_REQUEST`/`LIST_MODELS`). Config gets a new `update.restartCommand` field.

**Tech Stack:** Node.js child_process.execSync, Zod config, existing PubNub event publishing.

---

### Task 1: Add `update` config schema

**Files:**
- Modify: `app/config/schema.ts:75-96`
- Modify: `__tests__/config/schema.test.ts`

**Step 1: Write failing test**

Add to `__tests__/config/schema.test.ts`:

```typescript
it('accepts update.restartCommand config', () => {
  const config = agentConfigSchema.parse({
    agentName: 'test',
    workspace: { baseDir: '/tmp' },
    update: { restartCommand: 'pm2 restart milo' },
  });
  expect(config.update.restartCommand).toBe('pm2 restart milo');
});

it('defaults update config to empty', () => {
  const config = agentConfigSchema.parse({
    agentName: 'test',
    workspace: { baseDir: '/tmp' },
  });
  expect(config.update.restartCommand).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/config/schema.test.ts -v`
Expected: FAIL — `update` not recognized in schema

**Step 3: Implement config schema**

In `app/config/schema.ts`, add before `agentConfigSchema`:

```typescript
export const updateConfigSchema = z.object({
  restartCommand: z.string().optional(),
});
```

Add to `agentConfigSchema` object (after `streaming`):

```typescript
update: updateConfigSchema.default({}),
```

Add to exports:

```typescript
export type UpdateConfig = z.infer<typeof updateConfigSchema>;
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/config/schema.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add app/config/schema.ts __tests__/config/schema.test.ts
git commit -m "feat: add update.restartCommand config schema"
```

---

### Task 2: Add `force` field to PubNub control message type

**Files:**
- Modify: `app/messaging/pubnub-types.ts:24-32`

**Step 1: Add `force` to `PubNubControlMessage`**

In `app/messaging/pubnub-types.ts`, modify the `PubNubControlMessage` interface:

```typescript
/** Server -> Agent control messages (received on cmd channel) */
export interface PubNubControlMessage {
  type: string;
  ui_action?: string;
  agentId: string;
  sessionId: string;
  sessionName?: string;
  force?: boolean;
  timestamp: string;
}
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (adding an optional field is backwards compatible)

**Step 3: Commit**

```bash
git add app/messaging/pubnub-types.ts
git commit -m "feat: add force field to PubNubControlMessage"
```

---

### Task 3: Create `updater.ts` module

**Files:**
- Create: `app/orchestrator/updater.ts`
- Create: `__tests__/orchestrator/updater.test.ts`

**Step 1: Write failing tests**

Create `__tests__/orchestrator/updater.test.ts`:

```typescript
import { detectInstallMethod, getPackageRoot } from '../../app/orchestrator/updater.js';
import { existsSync } from 'fs';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

describe('updater', () => {
  describe('getPackageRoot', () => {
    it('returns a directory path', () => {
      const root = getPackageRoot();
      expect(typeof root).toBe('string');
      expect(root.length).toBeGreaterThan(0);
    });
  });

  describe('detectInstallMethod', () => {
    it('returns git when .git directory exists', () => {
      mockedExistsSync.mockReturnValue(true);
      expect(detectInstallMethod('/fake/root')).toBe('git');
    });

    it('returns npm when .git directory does not exist', () => {
      mockedExistsSync.mockReturnValue(false);
      expect(detectInstallMethod('/fake/root')).toBe('npm');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/orchestrator/updater.test.ts -v`
Expected: FAIL — module not found

**Step 3: Implement updater module**

Create `app/orchestrator/updater.ts`:

```typescript
/**
 * Agent self-update module.
 *
 * Detects install method (git clone vs npm global) and runs
 * the appropriate update commands.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type InstallMethod = 'git' | 'npm';

/**
 * Resolve the package root directory (where package.json lives).
 * Works whether running from source (app/) or built (dist/).
 */
export function getPackageRoot(): string {
  // __dirname is app/orchestrator or dist/orchestrator
  // Package root is two levels up
  return join(__dirname, '..', '..');
}

/**
 * Detect whether the agent was installed via git clone or npm global.
 */
export function detectInstallMethod(packageRoot: string): InstallMethod {
  return existsSync(join(packageRoot, '.git')) ? 'git' : 'npm';
}

export interface UpdateResult {
  success: boolean;
  method: InstallMethod;
  output: string;
  error?: string;
}

/**
 * Run the update commands for the detected install method.
 * Calls onProgress with status messages during execution.
 */
export function runUpdate(
  packageRoot: string,
  method: InstallMethod,
  onProgress: (message: string) => void,
): UpdateResult {
  const output: string[] = [];

  try {
    if (method === 'git') {
      onProgress('Pulling latest changes from git...');
      const pullOutput = execSync('git pull', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      output.push(pullOutput.trim());

      // Check if already up to date
      if (pullOutput.includes('Already up to date')) {
        return { success: true, method, output: 'Already up to date.' };
      }

      onProgress('Installing dependencies...');
      const installOutput = execSync('pnpm install --frozen-lockfile', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      output.push(installOutput.trim());

      onProgress('Building...');
      const buildOutput = execSync('pnpm build', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      output.push(buildOutput.trim());
    } else {
      onProgress('Updating via npm...');
      const npmOutput = execSync('npm update -g milo-bot-agent', {
        encoding: 'utf-8',
        timeout: 120_000,
      });
      output.push(npmOutput.trim());
    }

    return { success: true, method, output: output.join('\n') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, method, output: output.join('\n'), error: message };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/orchestrator/updater.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add app/orchestrator/updater.ts __tests__/orchestrator/updater.test.ts
git commit -m "feat: add updater module with install detection and update execution"
```

---

### Task 4: Wire up `update_milo_agent` in orchestrator

**Files:**
- Modify: `app/orchestrator/orchestrator.ts:14-19` (imports)
- Modify: `app/orchestrator/orchestrator.ts:268-318` (`handlePubNubControl` and `handleUiAction`)

**Step 1: Add import**

Add to orchestrator imports (around line 19):

```typescript
import { getPackageRoot, detectInstallMethod, runUpdate } from './updater.js';
```

**Step 2: Add `update_milo_agent` case to `handlePubNubControl`**

Modify `handlePubNubControl()` (line 268). The `update_milo_agent` action comes as a control message. Add a branch before the existing `ui_action` handler:

```typescript
private async handlePubNubControl(message: PubNubControlMessage): Promise<void> {
  this.logger.info(`PubNub control: ${message.type} (ui_action=${message.ui_action})`);

  if (message.ui_action === 'DELETE_SESSION' || message.type === 'session_deleted') {
    await this.handleDeleteSession(message.sessionId, message.sessionName);
  } else if (message.ui_action === 'UPDATE_MILO_AGENT') {
    await this.handleSelfUpdate(message.force);
  } else if (message.type === 'ui_action') {
    await this.handleUiAction(message as unknown as PubNubSkillCommand);
  } else {
    this.logger.verbose(`Unhandled control message type: ${message.type}`);
  }
}
```

**Step 3: Add `handleSelfUpdate` method**

Add a new private method to the Orchestrator class (after `handleUiAction`, around line 318):

```typescript
/**
 * Handle self-update: pull latest code, rebuild, and restart.
 */
private async handleSelfUpdate(force?: boolean): Promise<void> {
  this.logger.info(`Self-update requested (force=${force ?? false})`);

  // Check for busy sessions
  const activeSessions = this.actorManager.listActive();
  const busySessions = activeSessions.filter(
    (a) => a.status === 'OPEN_RUNNING'
  );

  if (busySessions.length > 0 && !force) {
    const sessionList = busySessions
      .map((a) => `- ${a.sessionName} (${a.sessionId})`)
      .join('\n');
    const warning = `Cannot update: ${busySessions.length} session(s) are currently running:\n${sessionList}\n\nSend the update command with force=true to update anyway.`;
    this.logger.warn(warning);
    this.broadcastEvent(warning);
    return;
  }

  const packageRoot = getPackageRoot();
  const method = detectInstallMethod(packageRoot);
  this.logger.info(`Detected install method: ${method} (root: ${packageRoot})`);

  const result = runUpdate(packageRoot, method, (progress) => {
    this.logger.info(`Update: ${progress}`);
    this.broadcastEvent(`Update: ${progress}`);
  });

  if (!result.success) {
    const errorMsg = `Update failed: ${result.error}\n\nThe agent is still running the previous version.`;
    this.logger.error(errorMsg);
    this.broadcastEvent(errorMsg);
    return;
  }

  const successMsg = result.output.includes('Already up to date')
    ? 'Agent is already up to date.'
    : `Update complete (${method}). Restarting...`;
  this.logger.info(successMsg);
  this.broadcastEvent(successMsg);

  // Don't restart if already up to date
  if (result.output.includes('Already up to date')) {
    return;
  }

  // Restart
  if (this.config.update?.restartCommand) {
    this.logger.info(`Running restart command: ${this.config.update.restartCommand}`);
    try {
      execSync(this.config.update.restartCommand, { stdio: 'inherit' });
    } catch (err) {
      this.logger.error('Restart command failed:', err);
    }
  }

  await this.stop();
  process.exit(0);
}
```

**Step 4: Add `broadcastEvent` helper and `execSync` import**

Add `execSync` to existing imports at top of file:

```typescript
import { execSync } from 'child_process';
```

Add a `broadcastEvent` helper method near `publishEvent` (around line 719):

```typescript
/**
 * Broadcast an event to all connected clients (no specific session).
 */
private broadcastEvent(content: string): void {
  if (this.pubnubAdapter?.isConnected) {
    this.pubnubAdapter.sendMessage(content).catch((err) => {
      this.logger.warn('PubNub broadcast failed:', err);
    });
  }
}
```

**Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat: wire up update_milo_agent control message in orchestrator"
```

---

### Task 5: End-to-end verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors

**Step 4: Build**

Run: `pnpm build`
Expected: Builds successfully

**Step 5: Commit any lint/type fixes if needed**

```bash
git add -A
git commit -m "chore: fix lint/type issues from self-update feature"
```
