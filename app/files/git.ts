/**
 * Git Operations
 *
 * Git-related operations for the agent.
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';

/**
 * Git execution options
 */
interface GitExecOptions {
  cwd: string;
  silent?: boolean;
}

/**
 * Execute a git command
 */
function gitExec(
  command: string,
  options: GitExecOptions
): { success: boolean; output: string; error?: string } {
  const execOptions: ExecSyncOptions = {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: options.silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
  };

  try {
    const output = execSync(`git ${command}`, execOptions);
    return { success: true, output: output?.toString() ?? '' };
  } catch (error) {
    const err = error as { stderr?: Buffer; message: string };
    const errorOutput = err.stderr?.toString() ?? err.message;
    return { success: false, output: '', error: errorOutput };
  }
}

/**
 * Initialize a git repository
 *
 * @param repoPath - Path to initialize
 * @param options - Init options
 * @returns True if successful
 */
export function initRepo(
  repoPath: string,
  options: { initialBranch?: string } = {}
): boolean {
  const { initialBranch = 'main' } = options;

  logger.info(`Initializing git repo in ${repoPath}`);

  const result = gitExec(`init -b ${initialBranch}`, { cwd: repoPath });

  if (!result.success) {
    logger.error('Git init failed:', result.error);
    return false;
  }

  logger.debug('Git repo initialized');
  return true;
}

/**
 * Check if a directory is a git repository
 *
 * @param path - Path to check
 * @returns True if it's a git repo
 */
export function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/**
 * Stage files for commit
 *
 * @param repoPath - Repository path
 * @param files - Files to stage (use '.' or '-A' for all)
 * @returns True if successful
 */
export function stageFiles(repoPath: string, files: string | string[]): boolean {
  const fileArg = Array.isArray(files) ? files.join(' ') : files;
  const result = gitExec(`add ${fileArg}`, { cwd: repoPath });

  if (!result.success) {
    logger.error('Git add failed:', result.error);
    return false;
  }

  return true;
}

/**
 * Create a commit
 *
 * @param repoPath - Repository path
 * @param message - Commit message
 * @param options - Commit options
 * @returns True if successful
 */
export function commit(
  repoPath: string,
  message: string,
  options: { addAll?: boolean; allowEmpty?: boolean } = {}
): boolean {
  const { addAll = false, allowEmpty = false } = options;

  // Stage files if requested
  if (addAll) {
    if (!stageFiles(repoPath, '-A')) {
      return false;
    }
  }

  // Build commit command
  let cmd = `commit -m "${message.replace(/"/g, '\\"')}"`;
  if (allowEmpty) {
    cmd += ' --allow-empty';
  }

  const result = gitExec(cmd, { cwd: repoPath });

  if (!result.success) {
    // "nothing to commit" is not really an error
    if (result.error?.includes('nothing to commit')) {
      logger.debug('Nothing to commit');
      return true;
    }
    logger.error('Git commit failed:', result.error);
    return false;
  }

  logger.debug(`Committed: ${message}`);
  return true;
}

/**
 * Push to remote
 *
 * @param repoPath - Repository path
 * @param remote - Remote name
 * @param branch - Branch name (optional)
 * @returns True if successful
 */
export function push(
  repoPath: string,
  remote = 'origin',
  branch?: string
): boolean {
  let cmd = `push ${remote}`;
  if (branch) {
    cmd += ` ${branch}`;
  }

  const result = gitExec(cmd, { cwd: repoPath });

  if (!result.success) {
    logger.error('Git push failed:', result.error);
    return false;
  }

  logger.debug(`Pushed to ${remote}${branch ? ` ${branch}` : ''}`);
  return true;
}

/**
 * Get current branch name
 *
 * @param repoPath - Repository path
 * @returns Branch name or null
 */
export function getCurrentBranch(repoPath: string): string | null {
  const result = gitExec('rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    silent: true,
  });

  if (!result.success) {
    return null;
  }

  return result.output.trim();
}

/**
 * Get repository status
 *
 * @param repoPath - Repository path
 * @returns Status info
 */
export function getStatus(repoPath: string): {
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
} {
  const result = gitExec('status --porcelain', { cwd: repoPath, silent: true });

  if (!result.success) {
    return { clean: true, staged: [], unstaged: [], untracked: [] };
  }

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const lines = result.output.split('\n').filter(Boolean);

  for (const line of lines) {
    const status = line.slice(0, 2);
    const file = line.slice(3);

    if (status === '??') {
      untracked.push(file);
    } else if (status[0] !== ' ') {
      staged.push(file);
    } else if (status[1] !== ' ') {
      unstaged.push(file);
    }
  }

  return {
    clean: lines.length === 0,
    staged,
    unstaged,
    untracked,
  };
}

/**
 * Get latest commit info
 *
 * @param repoPath - Repository path
 * @returns Commit info or null
 */
export function getLatestCommit(repoPath: string): {
  hash: string;
  message: string;
  author: string;
  date: Date;
} | null {
  const result = gitExec('log -1 --format="%H|%s|%an|%aI"', {
    cwd: repoPath,
    silent: true,
  });

  if (!result.success) {
    return null;
  }

  const [hash, message, author, dateStr] = result.output.trim().split('|');
  if (!hash) return null;

  return {
    hash,
    message: message ?? '',
    author: author ?? '',
    date: new Date(dateStr ?? Date.now()),
  };
}

/**
 * Configure git user
 *
 * @param repoPath - Repository path
 * @param name - User name
 * @param email - User email
 * @returns True if successful
 */
export function configureUser(
  repoPath: string,
  name: string,
  email: string
): boolean {
  const nameResult = gitExec(`config user.name "${name}"`, { cwd: repoPath });
  const emailResult = gitExec(`config user.email "${email}"`, { cwd: repoPath });

  return nameResult.success && emailResult.success;
}

/**
 * Add a remote
 *
 * @param repoPath - Repository path
 * @param name - Remote name
 * @param url - Remote URL
 * @returns True if successful
 */
export function addRemote(repoPath: string, name: string, url: string): boolean {
  const result = gitExec(`remote add ${name} ${url}`, { cwd: repoPath });

  if (!result.success) {
    // Already exists might be okay
    if (result.error?.includes('already exists')) {
      logger.debug(`Remote ${name} already exists`);
      return true;
    }
    logger.error('Failed to add remote:', result.error);
    return false;
  }

  return true;
}

/**
 * Create a new branch
 *
 * @param repoPath - Repository path
 * @param branchName - Branch name
 * @param checkout - Whether to checkout the new branch
 * @returns True if successful
 */
export function createBranch(
  repoPath: string,
  branchName: string,
  checkout = true
): boolean {
  const cmd = checkout ? `checkout -b ${branchName}` : `branch ${branchName}`;
  const result = gitExec(cmd, { cwd: repoPath });

  if (!result.success) {
    logger.error('Failed to create branch:', result.error);
    return false;
  }

  return true;
}

/**
 * Checkout a branch
 *
 * @param repoPath - Repository path
 * @param branchName - Branch name
 * @returns True if successful
 */
export function checkout(repoPath: string, branchName: string): boolean {
  const result = gitExec(`checkout ${branchName}`, { cwd: repoPath });

  if (!result.success) {
    logger.error('Failed to checkout:', result.error);
    return false;
  }

  return true;
}
