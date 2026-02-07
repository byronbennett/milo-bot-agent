import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[logs]' });

export const logsCommand = new Command('logs')
  .description('Show recent logs')
  .option('-d, --dir <directory>', 'Workspace directory', '~/milo-workspace')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output (not implemented)')
  .action(async (options) => {
    const workspaceDir = options.dir.replace('~', homedir());
    const resolvedDir = resolve(workspaceDir);
    const logsDir = join(resolvedDir, 'logs');

    // Check if logs directory exists
    if (!existsSync(logsDir)) {
      console.log('No logs directory found.');
      console.log('Logs are created when the agent runs.');
      return;
    }

    // Find the most recent log file
    const logFiles = readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({
        name: f,
        path: join(logsDir, f),
        mtime: statSync(join(logsDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (logFiles.length === 0) {
      console.log('No log files found.');
      return;
    }

    const latestLog = logFiles[0];
    console.log(`Showing last ${options.lines} lines from ${latestLog.name}:`);
    console.log('---');

    // Read and show last N lines
    const content = readFileSync(latestLog.path, 'utf-8');
    const lines = content.trim().split('\n');
    const numLines = parseInt(options.lines, 10);
    const lastLines = lines.slice(-numLines);

    for (const line of lastLines) {
      console.log(line);
    }

    if (options.follow) {
      console.log('---');
      console.log('Note: --follow is not yet implemented');
    }
  });
