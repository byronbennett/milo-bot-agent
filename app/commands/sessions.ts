import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[sessions]' });

export const sessionsCommand = new Command('sessions')
  .description('List active and archived sessions')
  .option('-d, --dir <directory>', 'Workspace directory', '~/milo-workspace')
  .option('-a, --all', 'Include archived sessions')
  .action(async (options) => {
    const workspaceDir = options.dir.replace('~', homedir());
    const resolvedDir = resolve(workspaceDir);
    const sessionsDir = join(resolvedDir, 'SESSIONS');
    const archiveDir = join(sessionsDir, 'archive');

    console.log('');
    console.log('MiloBot Sessions');
    console.log('================');
    console.log('');

    // Check if workspace exists
    if (!existsSync(sessionsDir)) {
      console.log('No sessions directory found.');
      console.log('Run `milo init` to set up your workspace.');
      return;
    }

    // List active sessions
    const activeFiles = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.md') && f !== 'archive');

    console.log(`Active Sessions (${activeFiles.length}):`);
    if (activeFiles.length === 0) {
      console.log('  No active sessions');
    } else {
      for (const file of activeFiles) {
        const sessionName = file.replace('.md', '');
        const filePath = join(sessionsDir, file);
        const content = readFileSync(filePath, 'utf-8');

        // Extract status from session file
        const statusMatch = content.match(/- Status: (\w+)/);
        const status = statusMatch ? statusMatch[1] : 'unknown';

        console.log(`  - ${sessionName} [${status}]`);
      }
    }
    console.log('');

    // List archived sessions if requested
    if (options.all && existsSync(archiveDir)) {
      const archivedFiles = readdirSync(archiveDir)
        .filter((f) => f.endsWith('.md'));

      console.log(`Archived Sessions (${archivedFiles.length}):`);
      if (archivedFiles.length === 0) {
        console.log('  No archived sessions');
      } else {
        for (const file of archivedFiles.slice(0, 10)) {
          const sessionName = file.replace('.md', '');
          console.log(`  - ${sessionName}`);
        }
        if (archivedFiles.length > 10) {
          console.log(`  ... and ${archivedFiles.length - 10} more`);
        }
      }
      console.log('');
    }
  });
