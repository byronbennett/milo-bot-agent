# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MiloBot Agent is a TypeScript CLI that acts as a remote control for AI coding agents. It runs as a daemon, receiving user messages via PubNub (real-time) or REST polling, and delegates work to worker processes that use pi-agent-core for multi-provider LLM interactions. The package is published as `milo-bot-agent` with a `milo` CLI binary.

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

**Entry points:** `bin/milo.ts` (CLI) → `cli.ts` (commander routing) → `orchestrator/orchestrator.ts` (main process)

**Orchestrator (single process):**
- `orchestrator/orchestrator.ts` — Owns PubNub subscription, SQLite, session actor lifecycle, outbox flush, heartbeat. Routes messages to session actors.
- `orchestrator/session-actor.ts` — Manages per-session worker processes. Handles spawn/respawn, work queues (high priority for control, normal for messages), cancel escalation (SIGINT → SIGTERM → SIGKILL), steer/answer forwarding.
- `orchestrator/session-types.ts` — SessionActor, WorkItem, WorkerHandle types.
- `orchestrator/ipc-types.ts` — JSON Lines IPC protocol between orchestrator and workers.
- `orchestrator/ipc.ts` — sendIPC/parseIPC helpers for stdin/stdout JSON Lines.

**Worker (child process per session):**
- `orchestrator/worker.ts` — Reads IPC from stdin, creates a pi-agent-core `Agent` with tools, runs prompts, forwards events (streaming text, tool execution, questions) back to orchestrator via stdout.

**Core modules:**
1. `messaging/` — Adapter pattern: `WebAppAdapter` (REST polling) and `PubNubAdapter` (real-time pub/sub).
2. `intent/` — Parses user text into structured `ParsedIntent`. Regex patterns first (`patterns.ts`), AI fallback via pi-ai.
3. `personas/` — Persona resolver. Caches persona `.md` files in `PERSONAS/` directory (named `{personaId}--{personaVersionId}.md`). Downloads from API on cache miss. Each message carries `personaId`/`personaVersionId`; the worker resolves and recreates the agent when persona changes.
4. `agent-tools/` — Tool registry for pi-agent-core agents. Core tools (file, bash, search, git, notify) and CLI agent tools (claude_code, gemini_cli, codex_cli, browser). `loadTools(toolSet, ctx)` dispatches by set name.
5. `auto-answer/` — Three-tier system for automatically answering questions: (1) obvious pattern matching, (2) RULES.md rule lookup, (3) AI judgment.

**Supporting modules:**
- `config/` — Zod-validated config with `ai.agent` and `ai.utility` sub-configs for provider/model selection.
- `db/` — SQLite via better-sqlite3 for inbox, outbox, and session persistence.
- `session/` — Markdown-based session persistence in `~/milo-workspace/SESSIONS/`
- `skills/` — Skills registry. Scans workspace `SKILLS/` folder and builds system prompt addendum listing available skills for workers.
- `scheduler/` — Heartbeat scheduling (default 3 min, 5s with PubNub).
- `utils/ai-client.ts` — pi-ai wrapper for utility AI calls (intent parsing, prompt enhancement).
- `utils/logger.ts` — Color-coded singleton logger with levels.
- `utils/keychain.ts` — macOS `security` command integration.

**Legacy (deprecated):**
- `claude-code/` — Former claude-code-js SDK bridge. Replaced by pi-agent-core in workers. Stubs remain for backward compatibility with `agent.ts` and `task/executor.ts`.
- `agent.ts` — Former monolithic agent class. Being replaced by orchestrator pattern.

### Key Libraries
- **@mariozechner/pi-agent-core** — Agent framework with tool execution, streaming, and event subscriptions.
- **@mariozechner/pi-ai** — Multi-provider LLM client (Anthropic, OpenAI, Google, xAI). `getModel(provider, modelId)` + `complete(model, context)`.
- **@sinclair/typebox** — JSON schema definitions for agent tool parameters (re-exported by pi-ai as `Type`).

### Key Patterns
- **Worker-per-session** — Each session gets a dedicated child process for crash isolation.
- **JSON Lines IPC** — Orchestrator ↔ worker communication via stdin/stdout.
- **Adapter pattern** for messaging (swap REST vs PubNub).
- **Per-message persona** — Each message carries `personaId`/`personaVersionId`/`model`. Worker resolves persona from local cache or API, recreates agent when persona or model changes.
- **Steering** — Messages to busy sessions forwarded as `agent.steer()` instead of queueing.
- **Zod schemas** for all config validation with defaults merging.

## Testing

Jest with `ts-jest/presets/default-esm`. Tests live in `__tests__/` mirroring `app/` structure. The `--experimental-vm-modules` flag is required for ESM support (already configured in `pnpm test`).

## Environment Variables

- `MILO_API_KEY` — Required. Agent authentication key.
- `ANTHROPIC_API_KEY` — Optional. Enables AI-powered intent parsing, prompt enhancement, and auto-answer.
- `OPENAI_API_KEY` — Optional. Enables OpenAI models (GPT-4, o1, etc.) via pi-ai.
- `GEMINI_API_KEY` — Optional. Enables Google Gemini models via pi-ai.
- `MILO_API_URL` — Optional. Override API endpoint (default: `https://www.milobot.dev/api`).

## User Commands

- `/models` — Lists all available models based on configured API keys. Can be sent as a message or via `uiAction: 'list_models'`.
