import { existsSync, readFileSync, watchFile } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { agentConfigSchema, type AgentConfig } from './schema';
import { defaultConfig, getDefaultConfigPath } from './defaults';
import { loadApiKey, loadAnthropicKey } from '../utils/keychain';
import { initUtilityModel } from '../utils/ai-client';

export type { AgentConfig } from './schema';
export { defaultConfig, getDefaultConfigPath } from './defaults';

/**
 * Load configuration from file
 */
export async function loadConfig(configPath?: string): Promise<AgentConfig> {
  const path = configPath || getDefaultConfigPath();

  // If config file doesn't exist, return defaults
  if (!existsSync(path)) {
    console.warn(`Config file not found at ${path}, using defaults`);
    return defaultConfig;
  }

  try {
    // Read and parse config file
    const content = readFileSync(path, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Expand home directory in baseDir
    if (rawConfig.workspace?.baseDir) {
      rawConfig.workspace.baseDir = rawConfig.workspace.baseDir.replace('~', homedir());
    }

    // Validate and merge with defaults
    const config = agentConfigSchema.parse({
      ...defaultConfig,
      ...rawConfig,
      workspace: {
        ...defaultConfig.workspace,
        ...rawConfig.workspace,
      },
      claudeCode: {
        ...defaultConfig.claudeCode,
        ...rawConfig.claudeCode,
      },
      scheduler: {
        ...defaultConfig.scheduler,
        ...rawConfig.scheduler,
      },
      tasks: {
        ...defaultConfig.tasks,
        ...rawConfig.tasks,
      },
      tools: {
        ...defaultConfig.tools,
        ...rawConfig.tools,
      },
      ai: {
        ...defaultConfig.ai,
        ...rawConfig.ai,
      },
      messaging: {
        ...defaultConfig.messaging,
        ...rawConfig.messaging,
        webapp: {
          ...defaultConfig.messaging.webapp,
          ...rawConfig.messaging?.webapp,
        },
        telegram: {
          ...defaultConfig.messaging.telegram,
          ...rawConfig.messaging?.telegram,
        },
      },
    });

    // Load .env file if exists
    loadEnvFile(config.workspace.baseDir);

    // If MILO_API_KEY still not set, try the OS keychain
    if (!process.env.MILO_API_KEY) {
      try {
        const keychainKey = await loadApiKey();
        if (keychainKey) {
          process.env.MILO_API_KEY = keychainKey;
        }
      } catch {
        // Keychain unavailable, continue without it
      }
    }

    // If ANTHROPIC_API_KEY still not set, try the OS keychain
    if (!process.env.ANTHROPIC_API_KEY) {
      try {
        const keychainKey = await loadAnthropicKey();
        if (keychainKey) {
          process.env.ANTHROPIC_API_KEY = keychainKey;
        }
      } catch {
        // Keychain unavailable, continue without it
      }
    }

    // Configure the utility AI model from config
    initUtilityModel(config.ai.utility.provider, config.ai.utility.model);

    return config;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to load config: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Load environment variables from .env file
 */
function loadEnvFile(baseDir: string): void {
  const envPath = join(baseDir, '.env');

  if (!existsSync(envPath)) {
    return;
  }

  try {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse KEY=VALUE
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        // Don't override existing env vars
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to load .env file: ${error}`);
  }
}

/**
 * Watch config file for changes
 */
export function watchConfig(
  configPath: string,
  callback: (config: AgentConfig) => void
): void {
  watchFile(configPath, { interval: 5000 }, () => {
    loadConfig(configPath)
      .then((config) => callback(config))
      .catch((error) => console.error('Failed to reload config:', error));
  });
}
