import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[status]' });

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

      console.log(`Agent Name: ${config.agentName}`);
      console.log(`Workspace: ${resolvedDir}`);
      console.log(`Onboarding: ${config.onboardingComplete ? 'Complete' : 'Incomplete'}`);
      console.log('');

      // Check for API key
      const envPath = join(resolvedDir, '.env');
      let hasApiKey = false;
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        hasApiKey = envContent.includes('MILO_API_KEY=milo_');
      }

      console.log(`API Key: ${hasApiKey ? 'Configured' : 'Not configured'}`);
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

      if (!hasApiKey) {
        console.log('Next steps:');
        console.log('1. Get an API key from https://www.milobot.dev/settings');
        console.log(`2. Add it to ${join(resolvedDir, '.env')}`);
        console.log('3. Run `milo start` to start the agent');
      } else if (!config.onboardingComplete) {
        console.log('Next steps:');
        console.log('Run `milo start` to start the agent');
      }
    } catch (error) {
      logger.error('Failed to read config:', error);
    }
  });
