import { Command } from 'commander';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[stop]' });

export const stopCommand = new Command('stop')
  .description('Stop the MiloBot agent daemon')
  .action(async () => {
    logger.info('Stopping MiloBot agent...');

    // TODO: Implement daemon stop logic
    // This would involve finding and killing the daemon process
    // For now, the agent runs in foreground and is stopped with Ctrl+C

    logger.info('To stop the agent running in foreground, use Ctrl+C');
    logger.info('Daemon mode is not yet implemented.');
  });
