import { Command } from 'commander';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { sessionsCommand } from './commands/sessions';
import { logsCommand } from './commands/logs';

const program = new Command();

program
  .name('milo')
  .description('MiloBot CLI - Remote control for Claude Code')
  .version('0.1.0');

// Register commands
program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);
program.addCommand(sessionsCommand);
program.addCommand(logsCommand);

export { program };
