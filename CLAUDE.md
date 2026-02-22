# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MiloBot Agent is a TypeScript CLI that acts as a remote control for AI agents capable of coding, writing, research, and general-purpose tasks. It runs as a daemon, receiving user messages via PubNub (real-time) or REST polling, and delegates work to worker processes that use pi-agent-core for multi-provider LLM interactions. The package is published as `milo-bot-agent` with a `milo` CLI binary.

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
- `orchestrator/updater.ts` — Self-update and version tracking. Detects install method (git clone vs npm global), runs update commands (`git pull` + build or `npm update -g`), checks current version (git SHA or package.json), and queries GitHub API / npm registry for latest version.

**Worker (child process per session):**
- `orchestrator/worker.ts` — Reads IPC from stdin, creates a pi-agent-core `Agent` with tools, runs prompts, forwards events (streaming text, tool execution, questions) back to orchestrator via stdout.

**Core modules:**
1. `messaging/` — Adapter pattern: `WebAppAdapter` (REST polling) and `PubNubAdapter` (real-time pub/sub).
2. `intent/` — Parses user text into structured `ParsedIntent`. Regex patterns first (`patterns.ts`), AI fallback via pi-ai.
3. `personas/` — Persona resolver. Caches persona `.md` files in `PERSONAS/` directory (named `{personaId}--{personaVersionId}.md`). Downloads from API on cache miss. Each message carries `personaId`/`personaVersionId`; the worker resolves and recreates the agent when persona changes.
4. `agent-tools/` — Tool registry for pi-agent-core agents. Core tools (file, bash, search, git, notify) and CLI agent tools (claude_code, gemini_cli, codex_cli, browser). `loadTools(toolSet, ctx)` dispatches by set name.
5. `auto-answer/` — Three-tier system for automatically answering questions: (1) obvious pattern matching, (2) RULES.md rule lookup, (3) AI judgment.

**Encryption:**
- `crypto/encryption.ts` — Core primitives: AES-256-GCM encrypt/decrypt, PBKDF2 key derivation (600k iterations), DEK generation, DEK wrap/unwrap, password verifier (HMAC-SHA256).
- `crypto/message-crypto.ts` — Message-level field encryption/decryption. Encrypts `content` (inline), `formData` (as `{ _enc: "ENC:1:..." }`), `fileData.content` (preserving metadata). `decryptMessageFields` passes through plaintext for backward compatibility.

**Supporting modules:**
- `config/` — Zod-validated config with `ai.agent` and `ai.utility` sub-configs for provider/model selection. Includes `encryption` section (level, salt, wrappedDEK, wrappedDEKIV) and `update.restartCommand` for configuring how the agent restarts after self-update.
- `db/` — SQLite via better-sqlite3 for inbox, outbox, and session persistence.
- `session/` — Markdown-based session persistence in `~/milo-workspace/SESSIONS/`
- `skills/` — Skills registry. Scans workspace `SKILLS/` folder and builds system prompt addendum listing available skills for workers.
- `scheduler/` — Heartbeat scheduling (default 3 min, 5s with PubNub).
- `utils/ai-client.ts` — pi-ai wrapper for utility AI calls (intent parsing, prompt enhancement).
- `utils/logger.ts` — Color-coded singleton logger with levels.
- `utils/keychain.ts` — Cross-platform OS keychain integration (macOS `security`, Windows `cmdkey`/PowerShell, Linux `secret-tool`). Stores system keys (MILO_API_KEY, ANTHROPIC_API_KEY, etc.) and tool-specific keys under namespaced accounts.

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
- **Edge encryption** — Orchestrator is the encryption boundary. It decrypts incoming messages before routing to workers (workers always see plaintext) and encrypts outgoing messages before publishing to PubNub or REST. DEK is loaded from keychain+config on startup and cached in memory. Control messages (DELETE_SESSION, heartbeat, etc.) are NOT encrypted.
- **Key hierarchy** — Password → PBKDF2 → Master Key → wraps DEK. DEK encrypts messages. Password change re-wraps DEK without re-encrypting messages.
- **Self-update** — `UPDATE_MILO_AGENT` PubNub control message triggers git pull + rebuild (or npm update). Warns if workers are busy unless `force: true`. Restarts via configurable `update.restartCommand` or `process.exit(0)`.
- **Version tracking** — On startup, detects current version (git SHA or npm semver). Hourly checks GitHub API or npm registry for latest version. One-time PubNub notification on new version. Reports to `POST /api/agent/update-status`.

## Message Encryption

Three per-agent encryption levels configured during `milo init`:

| Level | Name | Description |
|-------|------|-------------|
| 1 | None | Messages in plaintext (default) |
| 2 | Server-Managed | Password stored encrypted on server; browser auto-loads it |
| 3 | E2E Zero-Knowledge | Password never leaves agent/browser; user enters each session |

**Crypto:** AES-256-GCM, PBKDF2-SHA256 (600k iterations), 32-byte salt/key/DEK, 12-byte IV per operation.

**Encrypted content format:** `"ENC:1:" + base64(IV[12] || ciphertext[N] || authTag[16])`

**Orchestrator handles all crypto:** Workers always receive/send plaintext. The orchestrator decrypts on ingestion and encrypts on egress.

**Config section:**
```json
{
  "encryption": {
    "level": 1,
    "salt": "base64...",
    "wrappedDEK": "base64...",
    "wrappedDEKIV": "base64..."
  }
}
```

**Encryption password** stored in OS keychain as `MILO_ENCRYPTION_PASSWORD`.

**Key files:**
- `app/crypto/encryption.ts` — Core primitives (deriveKey, encrypt, decrypt, wrapDEK, unwrapDEK, computeVerifier)
- `app/crypto/message-crypto.ts` — Field-level encrypt/decrypt (content, formData, fileData)

## Tool Key Storage

Agent-tools that need API keys should store/retrieve them via the OS keychain using the helpers in `utils/keychain.ts`. Keys are namespaced as `milo-bot-tool:<toolName>:<keyName>` to stay separate from system keys.

```typescript
import { saveToolKey, loadToolKey, deleteToolKey } from '../utils/keychain.js';

// Store a key
await saveToolKey('serper', 'api-key', 'sk-...');

// Retrieve a key (returns null if not found)
const key = await loadToolKey('serper', 'api-key');

// Delete a key
await deleteToolKey('serper', 'api-key');
```

System-level keys (MILO_API_KEY, ANTHROPIC_API_KEY, etc.) use their own dedicated helpers (`saveApiKey`, `loadAnthropicKey`, etc.) and are loaded automatically at startup in `config/index.ts`.

## Testing

Jest with `ts-jest/presets/default-esm`. Tests live in `__tests__/` mirroring `app/` structure. The `--experimental-vm-modules` flag is required for ESM support (already configured in `pnpm test`).

## Environment Variables (Stored securely in OS keychain)

- `MILO_API_KEY` — Required. Agent authentication key.
- `ANTHROPIC_API_KEY` — Optional. Enables AI-powered intent parsing, prompt enhancement, and auto-answer.
- `OPENAI_API_KEY` — Optional. Enables OpenAI models (GPT-4, o1, etc.) via pi-ai.
- `GEMINI_API_KEY` — Optional. Enables Google Gemini models via pi-ai.
- `MILO_ENCRYPTION_PASSWORD` — Optional. Encryption password for Level 2/3 agents. Set during `milo init`.
- `MILO_API_URL` — Optional. Override API endpoint (default: `https://www.milobot.dev/api`).

## User Commands

- `/models` — Lists all available models based on configured API keys. Can be sent as a message or via `uiAction: 'list_models'`.
- `/status` — Shows agent status including version, uptime, models, tools, skills, and active sessions. Includes update availability when a newer version is detected.

## Control Messages (PubNub)

These are non-session control actions sent as PubNub control messages with `ui_action`:

| ui_action | Description |
|-----------|-------------|
| `DELETE_SESSION` | Delete a session, stop its worker, remove session file |
| `UPDATE_MILO_AGENT` | Self-update: pull latest code, rebuild, restart. Supports `force: true` to bypass busy-worker check |
| `skill_install` / `skill_update` / `skill_delete` | Manage skills on the agent |
| `SET_HEARTBEAT_INTERVAL` | Set heartbeat interval. Requires `intervalMinutes` (> 2, <= 60). Persists to config.json |

## Config: `update` Section

```json
{
  "update": {
    "restartCommand": "pm2 restart milo"
  }
}
```

- `restartCommand` — Optional. Shell command to run after a successful update before the process exits. If not set, the agent just calls `process.exit(0)` and relies on an external process manager to restart it.

## Config: `encryption` Section

```json
{
  "encryption": {
    "level": 1,
    "salt": "base64-encoded-32-byte-salt",
    "wrappedDEK": "base64-encoded-wrapped-dek",
    "wrappedDEKIV": "base64-encoded-iv"
  }
}
```

- `level` — 1 (none), 2 (server-managed), or 3 (E2E zero-knowledge). Default: 1.
- `salt` — PBKDF2 salt, generated during `milo init`. Base64-encoded 32 bytes.
- `wrappedDEK` — Data Encryption Key wrapped with the master key derived from password. Base64-encoded.
- `wrappedDEKIV` — IV used to wrap the DEK. Base64-encoded 12 bytes.
