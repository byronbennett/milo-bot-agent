/**
 * setup_project Tool
 *
 * Creates a project folder and optionally clones a git repository.
 * This tool runs directly in the orchestrator without spinning up a sub-agent.
 * It is used for kanban board projects linked to project personas.
 */

import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from './index.js';

const SetupProjectParams = Type.Object({
  projectFolder: Type.String({
    description:
      'Full path where the project should be created or already exists. ' +
      'This is the working directory for all coding tasks.',
  }),
  repoUrl: Type.Optional(
    Type.String({
      description:
        'Git repository URL to clone into the project folder. ' +
        'If the folder already exists and contains a git repo, this is skipped.',
    })
  ),
  branch: Type.Optional(
    Type.String({
      description: 'Git branch to checkout after cloning. Defaults to the repo default branch.',
    })
  ),
});

export function createSetupProjectTool(
  ctx: ToolContext
): AgentTool<typeof SetupProjectParams> {
  return {
    name: 'setup_project',
    label: 'Setup Project',
    description:
      'Create a project folder and optionally clone a git repository into it. ' +
      'Use this to set up the working directory for a kanban project before starting tasks. ' +
      'If the folder already exists, it will be used as-is. ' +
      'If a repoUrl is provided and the folder does not exist, the repo will be cloned.',
    parameters: SetupProjectParams,
    execute: async (_toolCallId, params) => {
      const { projectFolder, repoUrl, branch } = params;
      const fullPath = resolve(projectFolder);

      const results: string[] = [];

      if (existsSync(fullPath)) {
        // Folder already exists — check if it's a git repo
        const isGitRepo = existsSync(resolve(fullPath, '.git'));
        results.push(`Project folder already exists: ${fullPath}`);

        if (isGitRepo) {
          // Pull latest changes
          try {
            const status = execSync('git status --short', {
              cwd: fullPath,
              stdio: 'pipe',
              encoding: 'utf-8',
            }).trim();

            if (status) {
              results.push(`Git repo has uncommitted changes (${status.split('\n').length} files).`);
            } else {
              results.push('Git repo is clean.');
            }

            // Fetch latest
            try {
              execSync('git fetch', { cwd: fullPath, stdio: 'pipe', timeout: 30000 });
              results.push('Fetched latest from remote.');
            } catch {
              results.push('Could not fetch from remote (may be offline or no remote configured).');
            }
          } catch {
            results.push('Could not check git status.');
          }
        } else {
          results.push('Not a git repository.');
        }
      } else if (repoUrl) {
        // Clone the repository
        try {
          const parentDir = resolve(fullPath, '..');
          mkdirSync(parentDir, { recursive: true });

          const cloneCmd = branch
            ? `git clone --branch ${branch} ${repoUrl} "${fullPath}"`
            : `git clone ${repoUrl} "${fullPath}"`;

          execSync(cloneCmd, { stdio: 'pipe', timeout: 120000, encoding: 'utf-8' });
          results.push(`Cloned ${repoUrl} into ${fullPath}`);

          if (branch) {
            results.push(`Checked out branch: ${branch}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text',
                text: `Failed to clone repository: ${msg}`,
              },
            ],
            details: { error: 'clone_failed', message: msg },
          };
        }
      } else {
        // Create empty project folder
        mkdirSync(fullPath, { recursive: true });
        results.push(`Created project folder: ${fullPath}`);

        // Initialize git repo
        try {
          execSync('git init', { cwd: fullPath, stdio: 'pipe' });
          results.push('Initialized empty git repository.');
        } catch {
          // Non-fatal
        }
      }

      // Notify that project path has been set
      ctx.onProjectSet?.(
        fullPath.split('/').pop() || 'project',
        fullPath,
        !existsSync(fullPath)
      );

      return {
        content: [
          {
            type: 'text',
            text: results.join('\n'),
          },
        ],
        details: {
          projectFolder: fullPath,
          repoUrl: repoUrl || null,
          branch: branch || null,
        },
      };
    },
  };
}
