import { existsSync } from 'fs';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { MiloAgent } from '../agent';
import { loadConfig } from '../config';
import { getDefaultConfigPath } from '../config/defaults';
import { Logger } from '../utils/logger';
import { runInit } from './init';

const logger = new Logger({ prefix: '[start]' });

export const startCommand = new Command('start')
  .description('Start the MiloBot agent daemon')
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --debug', 'Enable debug logging')
  .option('-v, --verbose', 'Enable verbose step-by-step logging')
  .option('--foreground', 'Run in foreground (don\'t daemonize)')
  .option('--no-pubnub', 'Disable PubNub real-time messaging (use polling)')
  .action(async (options) => {
    // Check if workspace is initialized
    const configPath = options.config || getDefaultConfigPath();
    if (!existsSync(configPath)) {
      if (process.stdout.isTTY) {
        console.log('');
        logger.info('MiloBot workspace not initialized.');
        console.log('');
        const shouldInit = await confirm({
          message: 'Run setup now?',
          default: true,
        });

        if (shouldInit) {
          await runInit({});
          // Re-check that config was actually created
          if (!existsSync(configPath)) {
            logger.error('Setup did not complete. Run `milo init` to try again.');
            process.exit(1);
          }
          console.log('');
        } else {
          logger.info('Run `milo init` to set up your workspace.');
          process.exit(0);
        }
      } else {
        logger.error('MiloBot workspace not initialized. Run `milo init` first.');
        process.exit(1);
      }
    }

    logger.info('Starting MiloBot agent...');

    // Load config first so .env file and keychain are read into process.env
    const config = await loadConfig(options.config);

    // Check for API key (now available from .env or keychain)
    if (!process.env.MILO_API_KEY) {
      logger.error('MILO_API_KEY is not set.');
      logger.error('Run `milo init` to configure your API key.');
      process.exit(1);
    }

    // Override PubNub config from CLI flag
    if (options.pubnub === false) {
      config.pubnub.enabled = false;
      logger.info('PubNub disabled via --no-pubnub flag, using polling');
    }

    try {
      const agent = new MiloAgent({
        config,
        debug: options.debug,
        verbose: options.verbose,
      });

      await agent.start();

      // Keep process running
      logger.info('Agent is running. Press Ctrl+C to stop.');

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      // Keep alive
      setInterval(() => {}, 1000);
    } catch (error) {
      logger.error('Failed to start agent:', error);
      process.exit(1);
    }
  });
