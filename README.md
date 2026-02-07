# @milo-bot/agent

Remote control CLI for Claude Code. Communicate with your AI coding agent from anywhere.

## Features

- Remote task delegation via web or messaging apps
- Automatic session management
- Smart auto-answer for common Claude Code questions
- Multi-agent support
- Works with any Claude Code installation

## Installation

```bash
npm install -g @milo-bot/agent
```

Or with pnpm:

```bash
pnpm add -g @milo-bot/agent
```

## Quick Start

1. **Get an API Key**

   Visit [milobot.dev/settings](https://www.milobot.dev/settings) and create a new agent.

2. **Initialize**

   ```bash
   milo init
   ```

   This creates your workspace at `~/milo-workspace` and configures your API key.

3. **Start the Agent**

   ```bash
   milo start
   ```

   Your agent is now connected and ready to receive tasks!

## Commands

| Command | Description |
|---------|-------------|
| `milo init` | Initialize workspace and configure API key |
| `milo start` | Start the agent and connect to server |
| `milo stop` | Stop the running agent |
| `milo status` | Check agent connection status |
| `milo sessions` | List active and recent sessions |
| `milo logs` | View agent logs |

## Workspace Structure

After initialization, your workspace looks like this:

```
~/milo-workspace/
├── .env                    # API key and secrets
├── config.json             # Agent configuration
├── MEMORY.md               # Long-term agent memory
├── RULES.md                # Auto-answer rules
├── SESSION/                # Active sessions
│   └── archive/            # Completed sessions
├── projects/               # Your project repos
├── templates/              # Project templates
└── tools/                  # Custom tools
```

## Configuration

Edit `~/milo-workspace/config.json` to customize:

```json
{
  "agentName": "Milo",
  "claudeCode": {
    "maxConcurrentSessions": 3
  },
  "scheduler": {
    "heartbeatIntervalMinutes": 3
  }
}
```

## Auto-Answer Rules

Define rules in `RULES.md` to automatically answer common Claude Code questions:

```markdown
## Global Rules

When Claude Code asks about folder permissions, answer "yes".
When Claude Code asks about installing dependencies, answer "yes".

## Dangerous Operations

When Claude Code asks about force pushing, ask the user.
```

## Requirements

- Node.js 20+
- Claude Code installed and authenticated
- MiloBot account at [milobot.dev](https://www.milobot.dev)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MILO_API_KEY` | Your agent API key |
| `MILO_API_URL` | API URL (default: milobot.dev) |
| `ANTHROPIC_API_KEY` | Claude API key (for AI features) |

## Support

- [Documentation](https://www.milobot.dev/docs)
- [GitHub Issues](https://github.com/your-org/milo-bot/issues)
- [Discord Community](https://discord.gg/milobot)

## License

MIT
