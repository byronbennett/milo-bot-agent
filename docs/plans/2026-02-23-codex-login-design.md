# Codex Login Authorization for OpenAI Integration

**Date:** 2026-02-23
**Status:** Design

## Problem

Users must currently paste an `OPENAI_API_KEY` during `milo init` to use OpenAI models via the Codex CLI. OpenAI's Codex CLI supports a native `codex login` flow that opens a browser for OAuth, which is simpler and avoids key management.

## Design

### Init Flow Changes

Replace the OpenAI API key section in `milo init` with a three-option prompt:

1. **`codex login`** (recommended) — runs `codex login` interactively, opens browser for OpenAI OAuth. Verified with `codex --version` after login.
2. **Paste API key** — existing behavior, for headless environments or users who prefer keys.
3. **Skip** — don't configure OpenAI.

When `codex login` is chosen:
1. Check `codex` binary exists via `findCodexBinary()` from `codex-cli-runtime.ts`
2. Spawn `codex login` with inherited stdio (user sees browser flow)
3. On exit code 0, run `codex --version` to verify auth
4. Save `openai.authMethod: "codex-login"` in config
5. No `OPENAI_API_KEY` is stored

Backward compatibility: existing configs with `OPENAI_API_KEY` continue to work. The `openai.authMethod` defaults to `"none"` and old configs without this field work as before.

### Config Schema Changes

Add `openaiConfigSchema` to `config/schema.ts`:

```typescript
export const openaiConfigSchema = z.object({
  authMethod: z.enum(['codex-login', 'api-key', 'none']).default('none'),
});
```

Add to `agentConfigSchema`:
```typescript
openai: openaiConfigSchema.default({}),
```

### Codex CLI Tool Changes

In `cli-agent-tools.ts`, env setup logic (lines 259-263):
- If `authMethod === 'codex-login'`: don't set `CODEX_API_KEY` env var — Codex uses its own stored OAuth credentials
- If `authMethod === 'api-key'` or no config: current behavior (set `CODEX_API_KEY` from `OPENAI_API_KEY`)

### Model Discovery

Models `gpt-5.3-codex` and `gpt-5.3-codex-spark` come from the server's curated allow-list. No agent-side model list hardcoding needed. The agent discovers them via the existing `getCuratedAllowList()` flow.

## Files Changed

1. `app/config/schema.ts` — Add `openaiConfigSchema`, export type
2. `app/config/defaults.ts` — Add default for `openai` section
3. `app/config/index.ts` — Merge `openai` config on load
4. `app/commands/init.ts` — Replace OpenAI key prompt with codex login / API key / skip choice
5. `app/agent-tools/cli-agent-tools.ts` — Respect `authMethod` in env setup
6. `CLAUDE.md` — Document new config section
