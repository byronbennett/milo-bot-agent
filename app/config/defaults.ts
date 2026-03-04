import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentConfig } from './schema';

/**
 * Default configuration values
 */
export const DEFAULT_WORKSPACE_DIR = join(homedir(), 'milo-workspace');

/**
 * Global config directory for Milo settings that persist across workspaces.
 * Stores the active workspace path so `milo start` can find it.
 */
const GLOBAL_CONFIG_DIR = join(homedir(), '.milo');
const WORKSPACE_PATH_FILE = join(GLOBAL_CONFIG_DIR, 'workspace-path');

/**
 * Save the workspace path to ~/.milo/workspace-path so other commands can find it.
 */
export function saveWorkspacePath(workspacePath: string): void {
  mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  writeFileSync(WORKSPACE_PATH_FILE, workspacePath, 'utf-8');
}

/**
 * Load the saved workspace path from ~/.milo/workspace-path.
 * Returns null if not set.
 */
export function loadWorkspacePath(): string | null {
  if (!existsSync(WORKSPACE_PATH_FILE)) return null;
  try {
    const saved = readFileSync(WORKSPACE_PATH_FILE, 'utf-8').trim();
    return saved || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the workspace directory: saved path > default.
 */
export function getWorkspaceDir(): string {
  return loadWorkspacePath() || DEFAULT_WORKSPACE_DIR;
}

export const defaultConfig: AgentConfig = {
  agentName: 'Milo',
  agentId: '',
  aliases: {
    CC: 'Claude Code',
    claude: 'Claude Code',
  },
  workspace: {
    baseDir: DEFAULT_WORKSPACE_DIR,
    projectsDir: 'PROJECTS',
    sessionsDir: 'SESSIONS',
    templatesDir: 'templates',
    toolsDir: 'TOOLS',
    skillsDir: 'SKILLS',
    personasDir: 'PERSONAS',
  },
  claudeCode: {
    maxConcurrentSessions: 3,
    startupMaxRetries: 5,
    startupRetryIntervalSeconds: 30,
    // NOTE: Must be true. OAuth-based use of the `claude` CLI binary is forbidden
    // by Claude Code TOS when invoked by an orchestrating agent.
    preferAPIKey: true,
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
  ai: {
    model: 'claude-sonnet-4-6',
    agent: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20250514',
    },
    utility: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
  },
  messaging: {
    activeAdapter: 'webapp',
    webapp: {
      apiUrl: 'https://www.milobot.dev/api',
      pollIntervalMs: 180000,
    },
    telegram: {
      enabled: false,
    },
  },
  pubnub: {
    enabled: true,
  },
  update: {},
  localModels: {
    ollama: {
      enabled: true,
      port: 11434,
    },
    lmStudio: {
      enabled: true,
      port: 1234,
    },
    timeoutMs: 2000,
  },
  streaming: false,
  onboardingComplete: false,
  encryption: {
    level: 1,
  },
  openai: {
    authMethod: 'none',
  },
  groq: {
    authMethod: 'none',
  },
};

/**
 * Get the default config path, checking saved workspace path first.
 */
export function getDefaultConfigPath(): string {
  return join(getWorkspaceDir(), 'config.json');
}
