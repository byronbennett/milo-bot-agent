# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MiloBot Agent is a TypeScript CLI that acts as a remote control for Claude Code. It runs as a daemon, polling a remote server for user messages, parsing intent, and delegating work to Claude Code sessions. The package is published as `milo-bot-agent` with a `milo` CLI binary.

## Commands

```bash
# Development (runs with tsx, hot-reload)
pnpm dev

# Build (tsup → dist/)
pnpm build

# Lint
pnpm lint

# Type check
pnpm typecheck

# Run all tests (Jest with ESM)
pnpm test

# Run a single test file
node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/intent/parser.test.ts

# Watch mode
pnpm test:watch

# Coverage
pnpm test:coverage
```

## Architecture

### Module System
ESM throughout (`"type": "module"`). TypeScript targets ES2022, bundled with tsup. Node 20+ required. Strict TypeScript enabled.

### Source Layout (`app/`)

**Entry points:** `bin/milo.ts` (CLI) → `cli.ts` (commander routing) → `agent.ts` (main orchestrator, ~565 lines)

**Core pipeline — message processing flows through these in order:**
1. `messaging/` — Adapter pattern with two implementations: `WebAppAdapter` (REST polling) and `PubNubAdapter` (real-time pub/sub). Both implement `MessagingAdapter` interface.
2. `intent/` — Parses user text into structured `ParsedIntent`. Uses regex patterns first (`patterns.ts`), falls back to AI if `ANTHROPIC_API_KEY` is set.
3. `prompt/` — Enhances casual task descriptions into detailed Claude Code prompts. Template-based (`templates.ts`) with optional AI enhancement.
4. `task/` — DAG-based task orchestrator. Tasks declare `dependsOn` by ID. Executor dispatches by `TaskType` (claude_code, file_*, git_*, shell, notify_user, etc.). Includes retry with exponential backoff (`retry.ts`).
5. `claude-code/` — Wrapper around `claude-code-js` SDK. Manages sessions, sends prompts, integrates with auto-answer.
6. `auto-answer/` — Three-tier system for automatically answering Claude Code questions: (1) obvious pattern matching, (2) RULES.md rule lookup, (3) AI judgment with confidence scoring.

**Supporting modules:**
- `session/` — Markdown-based session persistence in `~/milo-workspace/SESSION/`
- `scheduler/` — `node-cron` heartbeat (default 3 min interval)
- `tools/` — Plugin registry for built-in and custom tools with safety checks
- `config/` — Zod-validated config loaded from `~/milo-workspace/config.json` + `.env` + macOS keychain
- `utils/logger.ts` — Color-coded singleton logger with levels
- `utils/ai-client.ts` — Anthropic SDK wrapper
- `utils/keychain.ts` — macOS `security` command integration

### Graceful Degradation
When `ANTHROPIC_API_KEY` is not set, all AI features (intent parsing, prompt enhancement, auto-answer AI tier) fall back to pattern matching and templates. The agent remains fully functional without it.

### Key Patterns
- **Adapter pattern** for messaging (swap REST vs PubNub)
- **Handler registry** for task and tool execution (Map-based dispatch by type)
- **DAG resolution** for task dependencies
- **Exponential backoff with jitter** for retries
- **Zod schemas** for all config validation with defaults merging

## Testing

Jest with `ts-jest/presets/default-esm`. Tests live in `__tests__/` mirroring `app/` structure. The `--experimental-vm-modules` flag is required for ESM support (already configured in `pnpm test`).

## Environment Variables

- `MILO_API_KEY` — Required. Agent authentication key.
- `ANTHROPIC_API_KEY` — Optional. Enables AI-powered intent parsing, prompt enhancement, and auto-answer.
- `MILO_API_URL` — Optional. Override API endpoint (default: `https://www.milobot.dev/api`).
