# MiloBot Agent

A local AI coding agent you control from your phone or browser. MiloBot runs as a daemon on your machine, receives tasks via real-time messaging, and orchestrates AI-powered coding sessions using multiple LLM providers — with crash-isolated workers, swappable personas, and a growing set of built-in tools.

## What It Does

- **Run coding tasks remotely** — Send instructions from your phone or browser; the agent does the work on your machine
- **Multi-provider LLM support** — Use Anthropic (Claude), OpenAI (GPT-4, o1), Google (Gemini), or xAI models, switchable per-message
- **Multi-session orchestration** — Run multiple isolated coding sessions in parallel, each in its own worker process
- **Personas** — Hot-swap the agent's identity and behavior from the web UI without restarting
- **Smart auto-answer** — Three-tier system (pattern matching, rules, AI judgment) handles routine questions so you don't have to babysit
- **Structured forms** — The agent can request typed input (text, numbers, checkboxes, dropdowns) via the web UI
- **Skills** — Install, update, and remove markdown-based skill definitions remotely from the browser
- **Self-update** — Trigger updates from the web UI; the agent pulls, rebuilds, and restarts itself
- **Real-time + reliable** — PubNub for instant delivery, REST polling as fallback, SQLite-backed message persistence

## Built-in Tools

Workers have access to a full set of coding tools:

| Category | Tools |
|----------|-------|
| **File system** | `read_file`, `write_file`, `list_files`, `grep` |
| **Shell** | `bash` (with dangerous command detection) |
| **Git** | `git_status`, `git_diff`, `git_commit`, `git_log` |
| **Network** | `web_fetch` (full HTTP client) |
| **Delegation** | `claude_code_cli` (delegates to Claude Code via SDK) |
| **Communication** | `notify_user`, `request_user_input` (structured forms) |
| **Workspace** | `set_project` |

Tool sets are configurable: `full`, `minimal` (no CLI agents), or `chat` (conversational only).

## Installation

```bash
npm install -g milo-bot-agent
```

Or with pnpm:

```bash
pnpm add -g milo-bot-agent
```

## Quick Start

1. **Get an API Key** — Visit [milobot.dev/settings](https://www.milobot.dev/settings) and create a new agent.

2. **Initialize**

   ```bash
   milo init
   ```

   Creates your workspace at `~/milo-workspace` and configures your API key.

3. **Start the Agent**

   ```bash
   milo start
   ```

   Your agent is now connected and ready to receive tasks.

## Commands

| Command | Description |
|---------|-------------|
| `milo init` | Initialize workspace and configure API key |
| `milo start` | Start the agent daemon |
| `milo stop` | Stop the running agent |
| `milo status` | Check agent connection status |
| `milo sessions` | List active and recent sessions |
| `milo logs` | View agent logs |

In-chat commands (sent as messages from the web UI):

| Command | Description |
|---------|-------------|
| `/models` | List all available models based on configured API keys |
| `/status` | Show agent version, uptime, models, tools, skills, and active sessions |

## Workspace Structure

```
~/milo-workspace/
├── .env                    # API key and secrets
├── config.json             # Agent configuration
├── MEMORY.md               # Long-term agent memory
├── RULES.md                # Auto-answer rules
├── SESSIONS/               # Active session files
│   └── archive/            # Completed sessions
├── PERSONAS/               # Cached persona definitions
├── SKILLS/                 # Skill definitions (.md files)
├── TOOLS/                  # Custom tools
├── projects/               # Your project repos
└── templates/              # Project templates
```

## Configuration

Edit `~/milo-workspace/config.json`:

```json
{
  "agentName": "Milo",
  "ai": {
    "agent": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6-20250514"
    },
    "utility": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  },
  "maxConcurrentSessions": 3,
  "update": {
    "restartCommand": "pm2 restart milo"
  }
}
```

The **agent** model runs your coding tasks. The **utility** model handles lightweight operations like intent parsing and auto-answer decisions.

## Auto-Answer Rules

Define rules in `~/milo-workspace/RULES.md` to automatically handle routine questions:

```markdown
## Global Rules

When asked about folder permissions, answer "yes".
When asked about installing dependencies, answer "yes".

## Dangerous Operations

When asked about force pushing, ask the user.
```

The three-tier system tries pattern matching first, then checks your rules, and falls back to AI judgment only when needed.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MILO_API_KEY` | Yes | Agent authentication key |
| `ANTHROPIC_API_KEY` | No | Enables Claude models and AI-powered features |
| `OPENAI_API_KEY` | No | Enables OpenAI models (GPT-4, o1, etc.) |
| `GEMINI_API_KEY` | No | Enables Google Gemini models |
| `MILO_API_URL` | No | Override API endpoint (default: milobot.dev) |

API keys are stored securely in your OS keychain.

## Requirements

- Node.js 20+
- MiloBot account at [milobot.dev](https://www.milobot.dev)

## Support

- [Documentation](https://www.milobot.dev/docs)
- [GitHub Issues](https://github.com/your-org/milo-bot/issues)
- [Discord Community](https://discord.gg/milobot)

## License

MIT
