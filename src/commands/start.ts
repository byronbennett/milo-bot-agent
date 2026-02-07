import { Command } from 'commander';
import { MiloAgent } from '../agent';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[start]' });

export const startCommand = new Command('start')
  .description('Start the MiloBot agent daemon')
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --debug', 'Enable debug logging')
  .option('--foreground', 'Run in foreground (don\'t daemonize)')
  .action(async (options) => {
    logger.info('Starting MiloBot agent...');

    // Check for API key
    if (!process.env.MILO_API_KEY) {
      logger.error('MILO_API_KEY environment variable is not set.');
      logger.error('Run `milo init` to set up your workspace and API key.');
      process.exit(1);
    }

    try {
      const agent = new MiloAgent({
        configPath: options.config,
        debug: options.debug,
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
