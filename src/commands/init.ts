import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import open from 'open';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[init]' });

const API_KEY_PATTERN = /^milo_[a-zA-Z0-9]+$/;

function validateApiKey(value: string): boolean | string {
  if (!value.trim()) return 'API key is required';
  if (!API_KEY_PATTERN.test(value.trim())) {
    return 'Invalid API key format. Keys start with "milo_"';
  }
  return true;
}

function expandPath(path: string): string {
  return path.replace(/^~/, homedir());
}

export const initCommand = new Command('init')
  .description('Initialize MiloBot agent workspace')
  .option('-k, --api-key <key>', 'API key from milobot.dev')
  .option('-d, --dir <directory>', 'Workspace directory')
  .option('-n, --name <name>', 'Agent name')
  .option('-y, --yes', 'Use defaults, non-interactive mode')
  .option('--no-browser', 'Skip opening browser for API key')
  .action(async (options) => {
    console.log('');
    console.log('🤖 Welcome to MiloBot Setup!');
    console.log('');

    const isInteractive = !options.yes && process.stdout.isTTY;

    // Determine workspace directory
    let workspaceDir: string;
    if (options.dir) {
      workspaceDir = expandPath(options.dir);
    } else if (isInteractive) {
      const dirInput = await input({
        message: 'Where should I create your workspace?',
        default: '~/milo-workspace',
      });
      workspaceDir = expandPath(dirInput);
    } else {
      workspaceDir = expandPath('~/milo-workspace');
    }
    const resolvedDir = resolve(workspaceDir);

    // Check if already initialized
    const configPath = join(resolvedDir, 'config.json');
    if (existsSync(configPath)) {
      if (isInteractive) {
        const reinit = await confirm({
          message: `Workspace already exists at ${resolvedDir}. Reinitialize?`,
          default: false,
        });
        if (!reinit) {
          console.log('Setup cancelled.');
          return;
        }
      } else {
        logger.warn(`Workspace already exists at ${resolvedDir}`);
        logger.info('Use --yes to reinitialize or specify a different directory with --dir');
        return;
      }
    }

    // Determine agent name
    let agentName: string;
    if (options.name) {
      agentName = options.name.trim();
    } else if (isInteractive) {
      agentName = await input({
        message: 'What should I call this agent?',
        default: 'Milo',
      });
    } else {
      agentName = 'Milo';
    }

    // Determine API key
    let apiKey: string | undefined;
    if (options.apiKey) {
      const validation = validateApiKey(options.apiKey);
      if (validation !== true) {
        logger.error(validation as string);
        process.exit(1);
      }
      apiKey = options.apiKey.trim();
    } else if (isInteractive) {
      const hasKey = await confirm({
        message: 'Do you have an API key from milobot.dev?',
        default: false,
      });

      if (hasKey) {
        apiKey = await input({
          message: 'Enter your API key:',
          validate: validateApiKey,
        });
        apiKey = apiKey.trim();
      } else {
        console.log('');
        console.log('📋 Get your API key from: https://www.milobot.dev/settings');

        if (options.browser !== false) {
          console.log('   Opening browser...');
          try {
            await open('https://www.milobot.dev/settings');
          } catch {
            // Browser failed to open, continue anyway
          }
        }

        console.log('');
        apiKey = await input({
          message: 'Enter your API key when ready:',
          validate: validateApiKey,
        });
        apiKey = apiKey.trim();
      }
    }

    // Create workspace
    console.log('');
    console.log(`📁 Creating workspace at ${resolvedDir}...`);
    mkdirSync(resolvedDir, { recursive: true });

    // Create directory structure
    const dirs = ['SESSION', 'SESSION/archive', 'projects', 'templates', 'tools', 'logs'];
    for (const dir of dirs) {
      mkdirSync(join(resolvedDir, dir), { recursive: true });
    }

    // Create initial files
    const files = {
      'MEMORY.md': `# Agent Memory

> Long-term preferences and learnings for the agent.

## User Preferences

- [Add your preferences here]

## Common Patterns

- [Patterns the agent should remember]

## Project Notes

- [Notes about your projects]
`,
      'RULES.md': `# Auto-Answer Rules

> Rules for automatically answering Claude Code questions.

## Global Rules

When Claude Code asks about folder permissions, answer "yes".
When Claude Code asks about creating directories, answer "yes".
When Claude Code asks about installing dependencies, answer "yes".

## Dangerous Operations

When Claude Code asks about force pushing, ask the user.
When Claude Code asks about deleting files, ask the user.
When Claude Code asks about modifying system files, ask the user.
`,
      'templates/README.md': `# Project Name

> A brief description of the project.

## Getting Started

\`\`\`bash
# Install dependencies
npm install

# Start development server
npm run dev
\`\`\`

## License

MIT
`,
      'templates/.gitignore': `# Dependencies
node_modules/

# Build outputs
dist/
.next/

# Environment
.env
.env.local

# IDE
.vscode/
.idea/

# OS
.DS_Store
`,
    };

    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(resolvedDir, filename), content);
    }

    // Create .gitkeep files
    const gitkeepDirs = ['SESSION/archive', 'projects', 'tools', 'logs'];
    for (const dir of gitkeepDirs) {
      writeFileSync(join(resolvedDir, dir, '.gitkeep'), '');
    }

    // Create config
    const config = {
      agentName,
      agentId: '',
      aliases: {
        CC: 'Claude Code',
        claude: 'Claude Code',
      },
      workspace: {
        baseDir: resolvedDir,
        projectsDir: 'projects',
        sessionsDir: 'SESSION',
        templatesDir: 'templates',
        toolsDir: 'tools',
      },
      claudeCode: {
        maxConcurrentSessions: 3,
        startupMaxRetries: 5,
        startupRetryIntervalSeconds: 30,
      },
      scheduler: {
        heartbeatIntervalMinutes: 3,
        userNotificationThrottleMinutes: 20,
      },
      tasks: {
        maxRetries: 3,
      },
      tools: {
        safeTools: ['create-project', 'init-git-repo', 'list-files'],
        requireConfirmation: ['delete-project', 'force-push'],
      },
      messaging: {
        activeAdapter: 'webapp',
        webapp: {
          apiUrl: 'https://www.milobot.dev/api',
          pollIntervalMs: 60000,
        },
        telegram: {
          enabled: false,
        },
      },
      onboardingComplete: !!apiKey,
    };

    // Write .env file
    if (apiKey) {
      writeFileSync(join(resolvedDir, '.env'), `MILO_API_KEY=${apiKey}\n`);
      console.log('🔑 API key saved');
    } else {
      writeFileSync(join(resolvedDir, '.env'), '# Add your API key here\nMILO_API_KEY=\n');
    }

    // Write config
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log('✅ Workspace created successfully!');
    console.log('');

    if (apiKey) {
      console.log('🚀 Next: Run `milo start` to connect your agent');
    } else {
      console.log('Next steps:');
      console.log('  1. Get an API key from https://www.milobot.dev/settings');
      console.log(`  2. Add it to ${join(resolvedDir, '.env')}`);
      console.log('  3. Run `milo start` to connect your agent');
    }
    console.log('');
  });
