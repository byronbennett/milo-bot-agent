# Design: `milo start` prompts for init when workspace not initialized

## Problem

When a developer clones the repo, builds, and runs `milo start`, they get a hard `process.exit(1)` with "MILO_API_KEY environment variable is not set." This is unhelpful — the real issue is that the workspace hasn't been initialized.

## Solution

Make `milo start` detect an uninitialized workspace and offer to run `milo init` inline.

## Changes

### `app/commands/init.ts`

Extract the init action handler into a named exported async function `runInit(options)` so it can be called programmatically from `start.ts`. The `.action()` call delegates to this function.

### `app/commands/start.ts`

Add a workspace initialization check before loading the agent:

1. Check if `getDefaultConfigPath()` (`~/milo-workspace/config.json`) exists.
2. If missing and TTY: prompt "MiloBot workspace not initialized. Run setup now?"
   - Yes: call `runInit({})` then continue to start.
   - No: exit with "Run `milo init` to set up your workspace."
3. If missing and not TTY: hard-exit with "Run `milo init` first."
4. After init (or if config already exists), proceed to `loadConfig()` and the existing `MILO_API_KEY` check.

### No other files change

- `milo init` standalone behavior is identical.
- Config loading, agent startup, all other commands unaffected.
- No new dependencies.
