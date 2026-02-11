/**
 * Init Git Repo Tool
 *
 * Initializes a git repository in a directory.
 */

import { registerTool } from '../registry';
import { initRepo, commit, addRemote, isGitRepo, exists } from '../../files';
import { logger } from '../../utils/logger';
import type { ToolMeta, ToolResult, ToolContext } from '../types';

const meta: ToolMeta = {
  name: 'init-git-repo',
  description: 'Initialize a git repository with optional initial commit and remote',
  safe: true,
  aliases: ['git-init'],
  args: {
    path: {
      type: 'string',
      description: 'Path to initialize (defaults to current project)',
      required: false,
    },
    initialCommit: {
      type: 'boolean',
      description: 'Create an initial commit',
      default: true,
    },
    commitMessage: {
      type: 'string',
      description: 'Initial commit message',
      default: 'Initial commit',
    },
    remote: {
      type: 'string',
      description: 'Remote URL to add as origin (optional)',
      required: false,
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const path = (args.path as string) || context.currentProject || context.workspaceDir;
  const initialCommit = args.initialCommit !== false;
  const commitMessage = (args.commitMessage as string) || 'Initial commit';
  const remote = args.remote as string | undefined;

  logger.info(`Initializing git repo in: ${path}`);

  // Check if path exists
  if (!exists(path)) {
    return {
      success: false,
      error: `Path does not exist: ${path}`,
    };
  }

  // Check if already a git repo
  if (isGitRepo(path)) {
    return {
      success: false,
      error: `Already a git repository: ${path}`,
    };
  }

  // Initialize repo
  const initSuccess = initRepo(path);
  if (!initSuccess) {
    return {
      success: false,
      error: 'Failed to initialize git repository',
    };
  }

  // Create initial commit if requested
  if (initialCommit) {
    const commitSuccess = commit(path, commitMessage, {
      addAll: true,
      allowEmpty: true,
    });
    if (!commitSuccess) {
      logger.warn('Initial commit failed');
    }
  }

  // Add remote if provided
  if (remote) {
    const remoteSuccess = addRemote(path, 'origin', remote);
    if (!remoteSuccess) {
      logger.warn('Failed to add remote');
    }
  }

  return {
    success: true,
    output: `Git repository initialized in ${path}`,
    data: { path, hasRemote: !!remote },
  };
}

// Register the tool
registerTool(meta, execute, 'built-in');

export { meta, execute };
