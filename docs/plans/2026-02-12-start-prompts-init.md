# Start Prompts Init Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `milo start` detect an uninitialized workspace and offer to run `milo init` inline before starting.

**Architecture:** Extract the init action handler into a reusable `runInit()` function. In the start command, check for `config.json` before loading the agent — if missing, prompt to run init (TTY) or hard-exit with a helpful message (non-TTY).

**Tech Stack:** TypeScript, commander, @inquirer/prompts (already dependencies)

---

### Task 1: Extract init action into reusable `runInit()` function

**Files:**
- Modify: `app/commands/init.ts:281-719`

**Step 1: Extract the action handler**

In `app/commands/init.ts`, the anonymous function passed to `.action(async (options) => { ... })` starting at line 291 needs to become a named exported function. Replace lines 281-719 with:

```typescript
/**
 * Run the init flow programmatically.
 * Accepts the same options object that commander would pass.
 */
export async function runInit(options: {
  apiKey?: string;
  anthropicKey?: string;
  aiModel?: string;
  dir?: string;
  name?: string;
  serverUrl?: string;
  yes?: boolean;
  browser?: boolean;
} = {}): Promise<void> {
  // <-- paste the existing action body here unchanged (lines 292-718) -->
}

export const initCommand = new Command('init')
  .description('Initialize MiloBot agent workspace')
  .option('-k, --api-key <key>', 'API key from milobot.dev')
  .option('--anthropic-key <key>', 'Anthropic API key for Milo AI features')
  .option('--ai-model <model>', 'Model for Milo AI calls (not Claude Code)')
  .option('-d, --dir <directory>', 'Workspace directory')
  .option('-n, --name <name>', 'Agent name')
  .option('-s, --server-url <url>', 'Server URL (default: https://www.milobot.dev)')
  .option('-y, --yes', 'Use defaults, non-interactive mode')
  .option('--no-browser', 'Skip opening browser for API key')
  .action(runInit);
```

The body of `runInit` is the exact same code that was previously inline (lines 292-718). No logic changes.

**Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add app/commands/init.ts
git commit -m "refactor: extract init action into reusable runInit function"
```

---

### Task 2: Add workspace check to start command

**Files:**
- Modify: `app/commands/start.ts`

**Step 1: Add the workspace initialization check**

Replace the entire contents of `app/commands/start.ts` with:

```typescript
import { existsSync } from 'fs';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { MiloAgent } from '../agent';
import { loadConfig } from '../config';
import { getDefaultConfigPath } from '../config/defaults';
import { Logger } from '../utils/logger';
import { runInit } from './init';

const logger = new Logger({ prefix: '[start]' });

export const startCommand = new Command('start')
  .description('Start the MiloBot agent daemon')
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --debug', 'Enable debug logging')
  .option('-v, --verbose', 'Enable verbose step-by-step logging')
  .option('--foreground', 'Run in foreground (don\'t daemonize)')
  .option('--no-pubnub', 'Disable PubNub real-time messaging (use polling)')
  .action(async (options) => {
    // Check if workspace is initialized
    const configPath = options.config || getDefaultConfigPath();
    if (!existsSync(configPath)) {
      if (process.stdout.isTTY) {
        console.log('');
        logger.info('MiloBot workspace not initialized.');
        console.log('');
        const shouldInit = await confirm({
          message: 'Run setup now?',
          default: true,
        });

        if (shouldInit) {
          await runInit({});
          // Re-check that config was actually created
          if (!existsSync(configPath)) {
            logger.error('Setup did not complete. Run `milo init` to try again.');
            process.exit(1);
          }
          console.log('');
        } else {
          logger.info('Run `milo init` to set up your workspace.');
          process.exit(0);
        }
      } else {
        logger.error('MiloBot workspace not initialized. Run `milo init` first.');
        process.exit(1);
      }
    }

    logger.info('Starting MiloBot agent...');

    // Load config first so .env file and keychain are read into process.env
    const config = await loadConfig(options.config);

    // Check for API key (now available from .env or keychain)
    if (!process.env.MILO_API_KEY) {
      logger.error('MILO_API_KEY is not set.');
      logger.error('Run `milo init` to configure your API key.');
      process.exit(1);
    }

    // Override PubNub config from CLI flag
    if (options.pubnub === false) {
      config.pubnub.enabled = false;
      logger.info('PubNub disabled via --no-pubnub flag, using polling');
    }

    try {
      const agent = new MiloAgent({
        config,
        debug: options.debug,
        verbose: options.verbose,
      });

      await agent.start();

      // Keep process running
      logger.info('Agent is running. Press Ctrl+C to stop.');

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      // Keep alive
      setInterval(() => {}, 1000);
    } catch (error) {
      logger.error('Failed to start agent:', error);
      process.exit(1);
    }
  });
```

**Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Verify build succeeds**

Run: `pnpm build`
Expected: Clean build with no errors

**Step 4: Commit**

```bash
git add app/commands/start.ts
git commit -m "feat: prompt to run init when workspace not initialized on start"
```
