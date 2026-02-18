import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/logger';
import { loadApiKey, loadAnthropicKey } from '../utils/keychain';

const logger = new Logger({ prefix: '[status]' });

async function resolveKeyStatus(
  loadFromKeychain: () => Promise<string | null>,
  envName: string,
  envPath: string,
): Promise<string> {
  // Check keychain first
  try {
    const keychainKey = await loadFromKeychain();
    if (keychainKey) return 'Configured (system keychain)';
  } catch {
    // Keychain unavailable
  }

  // Check .env
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const re = new RegExp(`^${envName}=.+`, 'm');
    if (re.test(content)) return 'Configured (.env file)';
  }

  return 'Not configured';
}

export const statusCommand = new Command('status')
  .description('Show agent status')
  .option('-d, --dir <directory>', 'Workspace directory', '~/milo-workspace')
  .action(async (options) => {
    const workspaceDir = options.dir.replace('~', homedir());
    const resolvedDir = resolve(workspaceDir);
    const configPath = join(resolvedDir, 'config.json');

    console.log('');
    console.log('MiloBot Agent Status');
    console.log('====================');
    console.log('');

    // Check if workspace exists
    if (!existsSync(configPath)) {
      console.log('Status: Not initialized');
      console.log('');
      console.log('Run `milo init` to set up your workspace.');
      return;
    }

    // Load config
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const envPath = join(resolvedDir, '.env');

      console.log(`Agent Name: ${config.agentName}`);
      console.log(`Workspace: ${resolvedDir}`);
      console.log(`Onboarding: ${config.onboardingComplete ? 'Complete' : 'Incomplete'}`);
      console.log('');

      // Check keys
      const miloKeyStatus = await resolveKeyStatus(loadApiKey, 'MILO_API_KEY', envPath);
      const anthropicKeyStatus = await resolveKeyStatus(loadAnthropicKey, 'ANTHROPIC_API_KEY', envPath);

      console.log(`MiloBot API Key: ${miloKeyStatus}`);
      console.log(`Anthropic API Key: ${anthropicKeyStatus}`);
      console.log(`AI Model: ${config.ai?.model ?? 'claude-sonnet-4-6 (default)'}`);
      console.log('');

      // Check messaging config
      console.log('Messaging:');
      console.log(`  Active Adapter: ${config.messaging.activeAdapter}`);
      console.log(`  API URL: ${config.messaging.webapp.apiUrl}`);
      console.log(`  Poll Interval: ${config.messaging.webapp.pollIntervalMs}ms`);
      console.log('');

      // TODO: Check if daemon is running
      console.log('Daemon: Not running (or status check not implemented)');
      console.log('');

      if (miloKeyStatus === 'Not configured' || anthropicKeyStatus === 'Not configured') {
        console.log('Next steps:');
        if (miloKeyStatus === 'Not configured') {
          const settingsUrl = config.messaging.webapp.apiUrl.replace(/\/api\/?$/, '');
          console.log(`  - Get a MiloBot API key from ${settingsUrl}/settings`);
        }
        if (anthropicKeyStatus === 'Not configured') {
          console.log('  - Get an Anthropic API key from https://console.anthropic.com/');
        }
        console.log('  - Run `milo init` to configure missing keys');
      } else if (!config.onboardingComplete) {
        console.log('Next steps:');
        console.log('Run `milo start` to start the agent');
      }
    } catch (error) {
      logger.error('Failed to read config:', error);
    }
  });
