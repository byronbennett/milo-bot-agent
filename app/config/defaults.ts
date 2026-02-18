import { homedir } from 'os';
import { join } from 'path';
import type { AgentConfig } from './schema';

/**
 * Default configuration values
 */
export const DEFAULT_WORKSPACE_DIR = join(homedir(), 'milo-workspace');

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
    model: 'claude-sonnet-4-5',
    agent: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
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
  streaming: false,
  onboardingComplete: false,
};

/**
 * Get the default config path
 */
export function getDefaultConfigPath(): string {
  return join(DEFAULT_WORKSPACE_DIR, 'config.json');
}
