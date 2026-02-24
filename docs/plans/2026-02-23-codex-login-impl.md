# Codex Login Authorization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `codex login` as the primary OpenAI auth method in `milo init`, with API key as fallback.

**Architecture:** During init, users choose between `codex login` (browser OAuth) or pasting an API key. A new `openai.authMethod` config field tracks which method was used. The codex CLI tool already works without `OPENAI_API_KEY` when `codex login` was used (Codex uses its own stored OAuth credentials), so the tool changes are minimal — just improved error messaging.

**Tech Stack:** TypeScript, Zod (config validation), Commander.js + Inquirer (CLI prompts), child_process (spawning codex login)

---

### Task 1: Add OpenAI config schema

**Files:**
- Modify: `app/config/schema.ts:95-134`
- Modify: `app/config/defaults.ts:10-86`
- Modify: `app/config/index.ts:35-82`

**Step 1: Add openaiConfigSchema to schema.ts**

Add after `encryptionConfigSchema` (line 100):

```typescript
export const openaiConfigSchema = z.object({
  authMethod: z.enum(['codex-login', 'api-key', 'none']).default('none'),
});
```

Add `openai` to `agentConfigSchema` (after `encryption` on line 121):

```typescript
  openai: openaiConfigSchema.default({}),
```

Add to the type exports at the bottom:

```typescript
export type OpenAIConfig = z.infer<typeof openaiConfigSchema>;
```

**Step 2: Add default to defaults.ts**

Add after `encryption` (line 84):

```typescript
  openai: {
    authMethod: 'none',
  },
```

**Step 3: Add merge logic to config/index.ts loadConfig**

Inside the `agentConfigSchema.parse()` call (around line 82), add:

```typescript
      openai: {
        ...defaultConfig.openai,
        ...rawConfig.openai,
      },
```

**Step 4: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors related to openai config

**Step 5: Commit**

```bash
git add app/config/schema.ts app/config/defaults.ts app/config/index.ts
git commit -m "feat(config): add openai.authMethod config schema"
```

---

### Task 2: Add codex login flow to milo init

**Files:**
- Modify: `app/commands/init.ts:641-660` (OpenAI section)
- Modify: `app/commands/init.ts:937-992` (config object and save secrets)

**Step 1: Add import for findCodexBinary and spawn**

At the top of `init.ts`, add:

```typescript
import { findCodexBinary } from '../agent-tools/codex-cli-runtime.js';
import { spawnSync } from 'child_process';
```

Note: `spawn` from `child_process` is NOT already imported; `spawnSync` is needed for the blocking login flow during init.

**Step 2: Add a variable for tracking OpenAI auth method**

Near the top of `runInit()`, alongside other state variables like `anthropicKey`, `openaiKey`, etc., add:

```typescript
let openaiAuthMethod: 'codex-login' | 'api-key' | 'none' = 'none';
```

**Step 3: Replace the OpenAI key section (lines 641-660)**

Replace the current OpenAI section with:

```typescript
      // --- OpenAI / Codex ---
      console.log('');
      console.log('🔑 OpenAI / Codex Authentication (optional)');
      console.log('   Enables OpenAI models (gpt-5.3-codex, gpt-5.3-codex-spark) via Codex CLI.');
      console.log('');

      // Check if existing config already has codex-login
      const existingOpenaiAuth = (existing.config as any)?.openai?.authMethod;

      if (existing.openaiKey) {
        // User has an existing API key — use existing promptForKey flow
        openaiKey = await promptForKey({
          label: 'OpenAI API key',
          existingKey: existing.openaiKey,
          existingSource: existing.openaiKeySource,
          validate: validateOpenAIKey,
          save: saveOpenAIKey,
          deleteFromKeychain: deleteOpenAIKey,
          envName: 'OPENAI_API_KEY',
          resolvedDir,
          isInteractive,
          cliValue: options.openaiKey,
          required: false,
        });
        openaiAuthMethod = openaiKey ? 'api-key' : 'none';
      } else if (existingOpenaiAuth === 'codex-login') {
        // Already using codex login
        const action = await select({
          message: 'OpenAI is configured via codex login.',
          choices: [
            { name: 'Keep codex login', value: 'keep' as const },
            { name: 'Re-run codex login', value: 'relogin' as const },
            { name: 'Switch to API key', value: 'apikey' as const },
            { name: 'Remove OpenAI', value: 'remove' as const },
          ],
          default: 'keep' as const,
        });

        if (action === 'keep') {
          openaiAuthMethod = 'codex-login';
        } else if (action === 'relogin') {
          openaiAuthMethod = await runCodexLogin() ? 'codex-login' : 'none';
        } else if (action === 'apikey') {
          const newKey = await input({ message: 'Enter your OpenAI API key:', validate: validateOpenAIKey });
          openaiKey = newKey.trim();
          openaiAuthMethod = 'api-key';
        } else {
          openaiAuthMethod = 'none';
        }
      } else if (options.openaiKey) {
        // CLI flag provided
        openaiKey = await promptForKey({
          label: 'OpenAI API key',
          existingKey: null,
          existingSource: null,
          validate: validateOpenAIKey,
          save: saveOpenAIKey,
          deleteFromKeychain: deleteOpenAIKey,
          envName: 'OPENAI_API_KEY',
          resolvedDir,
          isInteractive,
          cliValue: options.openaiKey,
          required: false,
        });
        openaiAuthMethod = openaiKey ? 'api-key' : 'none';
      } else {
        // Fresh setup — offer codex login vs API key vs skip
        const authChoice = await select({
          message: 'How would you like to authenticate with OpenAI?',
          choices: [
            { name: 'codex login (recommended) — opens browser for OpenAI sign-in', value: 'codex-login' as const },
            { name: 'Paste an API key', value: 'api-key' as const },
            { name: 'Skip — don\'t configure OpenAI', value: 'skip' as const },
          ],
        });

        if (authChoice === 'codex-login') {
          openaiAuthMethod = await runCodexLogin() ? 'codex-login' : 'none';
        } else if (authChoice === 'api-key') {
          console.log('');
          console.log('   Get an API key: https://platform.openai.com/api-keys');
          console.log('');
          openaiKey = await promptForKey({
            label: 'OpenAI API key',
            existingKey: null,
            existingSource: null,
            validate: validateOpenAIKey,
            save: saveOpenAIKey,
            deleteFromKeychain: deleteOpenAIKey,
            envName: 'OPENAI_API_KEY',
            resolvedDir,
            isInteractive,
            cliValue: undefined,
            required: false,
          });
          openaiAuthMethod = openaiKey ? 'api-key' : 'none';
        }
        // else skip — openaiAuthMethod stays 'none'
      }
```

**Step 4: Add the `runCodexLogin` helper function**

Add this function before `runInit()` (or near the other helper functions at the top of the file):

```typescript
/**
 * Run `codex login` interactively, then verify with `codex --version`.
 * Returns true on success, false on failure.
 */
async function runCodexLogin(): Promise<boolean> {
  let codexBinary: string;
  try {
    codexBinary = await findCodexBinary();
  } catch {
    console.log('');
    console.log('   Codex CLI not found. Install it first:');
    console.log('     npm install -g @openai/codex');
    console.log('');
    const fallback = await confirm({
      message: 'Would you like to enter an API key instead?',
      default: false,
    });
    if (fallback) {
      return false; // caller will handle API key prompt
    }
    return false;
  }

  console.log('');
  console.log('   Running codex login... A browser window will open for OpenAI sign-in.');
  console.log('');

  const loginResult = spawnSync(codexBinary, ['login'], {
    stdio: 'inherit',
  });

  if (loginResult.status !== 0) {
    console.log('');
    logger.warn('codex login failed or was cancelled.');
    return false;
  }

  // Verify auth works
  console.log('   Verifying authentication...');
  const verifyResult = spawnSync(codexBinary, ['--version'], {
    stdio: 'pipe',
  });

  if (verifyResult.status === 0) {
    const version = verifyResult.stdout?.toString().trim();
    console.log(`   Codex CLI authenticated successfully (${version})`);
    return true;
  }

  logger.warn('codex --version check failed after login.');
  return false;
}
```

**Step 5: Add `openai` to the config object (around line 970)**

In the config object created during init, add after the `encryption` section:

```typescript
      openai: {
        authMethod: openaiAuthMethod,
      },
```

**Step 6: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 7: Commit**

```bash
git add app/commands/init.ts
git commit -m "feat(init): add codex login as primary OpenAI auth method"
```

---

### Task 3: Update codex CLI tool model description

**Files:**
- Modify: `app/agent-tools/cli-agent-tools.ts:51,231-233`

**Step 1: Update the CodexParams model description**

Line 51 currently says:
```typescript
    Type.String({ description: 'Override model (default: gpt-5.3-codex). Examples: o3, gpt-5.3-codex' }),
```

Update to:
```typescript
    Type.String({ description: 'Override model (default: gpt-5.3-codex). Examples: gpt-5.3-codex, gpt-5.3-codex-spark' }),
```

**Step 2: Update the tool description**

Line 231-233 currently says:
```
'Use this for coding tasks when you want to leverage OpenAI models (o3, gpt-5.3-codex, etc.). ' +
```

Update to:
```
'Use this for coding tasks when you want to leverage OpenAI models (gpt-5.3-codex, gpt-5.3-codex-spark, etc.). ' +
```

**Step 3: Run typecheck**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add app/agent-tools/cli-agent-tools.ts
git commit -m "feat(codex): update model references to gpt-5.3-codex and gpt-5.3-codex-spark"
```

---

### Task 4: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add the openai config section to CLAUDE.md**

After the `## Config: \`encryption\` Section`, add:

```markdown
## Config: `openai` Section

\`\`\`json
{
  "openai": {
    "authMethod": "codex-login"
  }
}
\`\`\`

- `authMethod` — `"codex-login"` (OAuth via browser), `"api-key"` (OPENAI_API_KEY), or `"none"`. Default: `"none"`.
- When `codex-login`, the agent relies on Codex CLI's stored OAuth credentials. No API key is needed.
- When `api-key`, the agent uses `OPENAI_API_KEY` from keychain/env and passes it as `CODEX_API_KEY`.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add openai config section to CLAUDE.md"
```

---

### Task 5: Manual verification

**Step 1: Build the project**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm build`
Expected: Build succeeds

**Step 2: Verify the init flow interactively (optional)**

Run: `cd /Users/byron/dev/milo-bot/agent && node dist/bin/milo.js init`
Expected: See the new OpenAI auth choice (codex login / API key / skip)

**Step 3: Verify existing configs still load**

Check that an existing `config.json` without `openai` section loads without errors (the Zod schema defaults to `{ authMethod: 'none' }`).
