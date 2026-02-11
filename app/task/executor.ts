/**
 * Task Executor
 *
 * Executes individual tasks based on their type.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger';
import { sendPrompt, openSession, closeSession } from '../claude-code';
import { withRetry } from './retry';
import type { Task, TaskResult, TaskContext, TaskHandler, TaskType } from './types';

/**
 * Registry of task handlers by type
 */
const handlers: Map<TaskType, TaskHandler> = new Map();

/**
 * Register a task handler
 */
export function registerHandler(type: TaskType, handler: TaskHandler): void {
  handlers.set(type, handler);
}

/**
 * Execute a single task
 *
 * @param task - The task to execute
 * @param context - Execution context
 * @returns Task result
 */
export async function executeTask(
  task: Task,
  context: TaskContext
): Promise<TaskResult> {
  const handler = handlers.get(task.type);

  if (!handler) {
    logger.error(`No handler registered for task type: ${task.type}`);
    return {
      success: false,
      error: `Unknown task type: ${task.type}`,
    };
  }

  logger.info(`Executing task [${task.id}]: ${task.description}`);

  try {
    // Execute with retry if configured
    const maxRetries = task.maxRetries ?? 0;

    if (maxRetries > 0) {
      return await withRetry(() => handler(task, context), {
        maxRetries,
        onRetry: (attempt) => {
          task.retryCount = attempt;
        },
      });
    }

    return await handler(task, context);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Task [${task.id}] failed:`, errorMessage);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

// ============================================================================
// Built-in Task Handlers
// ============================================================================

/**
 * Claude Code task handler
 */
registerHandler('claude_code', async (task, context) => {
  const { prompt, systemPrompt } = task.params as {
    prompt: string;
    systemPrompt?: string;
  };

  if (!prompt) {
    return { success: false, error: 'No prompt specified' };
  }

  const projectPath = context.projectPath ?? context.workspaceDir;

  // Open a session if we don't have one
  const session = await openSession({ projectPath });

  try {
    const result = await sendPrompt(session.id, prompt, { systemPrompt });

    if (result.success) {
      return {
        success: true,
        output: result.result,
        data: {
          costUsd: result.costUsd,
          durationMs: result.durationMs,
        },
      };
    }

    return { success: false, error: result.error };
  } finally {
    closeSession(session.id);
  }
});

/**
 * File create handler
 */
registerHandler('file_create', async (task) => {
  const { path, content = '' } = task.params as {
    path: string;
    content?: string;
  };

  if (!path) {
    return { success: false, error: 'No path specified' };
  }

  try {
    // Create directory if needed
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, content, 'utf-8');
    logger.debug(`Created file: ${path}`);

    return { success: true, output: `Created: ${path}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * File read handler
 */
registerHandler('file_read', async (task) => {
  const { path } = task.params as { path: string };

  if (!path) {
    return { success: false, error: 'No path specified' };
  }

  try {
    if (!existsSync(path)) {
      return { success: false, error: `File not found: ${path}` };
    }

    const content = readFileSync(path, 'utf-8');
    return { success: true, output: content };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * File write handler
 */
registerHandler('file_write', async (task) => {
  const { path, content } = task.params as {
    path: string;
    content: string;
  };

  if (!path) {
    return { success: false, error: 'No path specified' };
  }

  try {
    writeFileSync(path, content, 'utf-8');
    logger.debug(`Wrote to file: ${path}`);

    return { success: true, output: `Updated: ${path}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * File delete handler
 */
registerHandler('file_delete', async (task) => {
  const { path } = task.params as { path: string };

  if (!path) {
    return { success: false, error: 'No path specified' };
  }

  try {
    if (!existsSync(path)) {
      return { success: true, output: `Already deleted: ${path}` };
    }

    unlinkSync(path);
    logger.debug(`Deleted file: ${path}`);

    return { success: true, output: `Deleted: ${path}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * Git init handler
 */
registerHandler('git_init', async (task) => {
  const { path, initialCommit = true } = task.params as {
    path: string;
    initialCommit?: boolean;
  };

  if (!path) {
    return { success: false, error: 'No path specified' };
  }

  try {
    execSync('git init', { cwd: path, stdio: 'pipe' });

    if (initialCommit) {
      execSync('git add .', { cwd: path, stdio: 'pipe' });
      execSync('git commit -m "Initial commit" --allow-empty', {
        cwd: path,
        stdio: 'pipe',
      });
    }

    return { success: true, output: `Initialized git repo in ${path}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * Git commit handler
 */
registerHandler('git_commit', async (task) => {
  const { path, message, addAll = true } = task.params as {
    path: string;
    message: string;
    addAll?: boolean;
  };

  if (!path || !message) {
    return { success: false, error: 'Path and message required' };
  }

  try {
    if (addAll) {
      execSync('git add -A', { cwd: path, stdio: 'pipe' });
    }

    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: path,
      stdio: 'pipe',
    });

    return { success: true, output: `Committed: ${message}` };
  } catch (error) {
    const errorStr = String(error);
    // "nothing to commit" is not really an error
    if (errorStr.includes('nothing to commit')) {
      return { success: true, output: 'Nothing to commit' };
    }
    return { success: false, error: errorStr };
  }
});

/**
 * Git push handler
 */
registerHandler('git_push', async (task) => {
  const { path, remote = 'origin', branch } = task.params as {
    path: string;
    remote?: string;
    branch?: string;
  };

  if (!path) {
    return { success: false, error: 'No path specified' };
  }

  try {
    const branchArg = branch ? ` ${branch}` : '';
    execSync(`git push ${remote}${branchArg}`, { cwd: path, stdio: 'pipe' });

    return { success: true, output: `Pushed to ${remote}${branchArg}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * Shell command handler
 */
registerHandler('shell', async (task) => {
  const { command, cwd } = task.params as {
    command: string;
    cwd?: string;
  };

  if (!command) {
    return { success: false, error: 'No command specified' };
  }

  try {
    const output = execSync(command, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    return { success: true, output };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

/**
 * Notify user handler (placeholder - actual implementation in agent)
 */
registerHandler('notify_user', async (task) => {
  const { message } = task.params as { message: string };

  if (!message) {
    return { success: false, error: 'No message specified' };
  }

  // This will be handled by the agent's messaging adapter
  logger.info(`[NOTIFY USER]: ${message}`);

  return {
    success: true,
    output: message,
    data: { requiresMessaging: true },
  };
});

/**
 * Wait handler
 */
registerHandler('wait', async (task) => {
  const { durationMs = 1000 } = task.params as { durationMs?: number };

  await new Promise((resolve) => setTimeout(resolve, durationMs));

  return { success: true, output: `Waited ${durationMs}ms` };
});

/**
 * Custom tool handler (placeholder)
 */
registerHandler('custom', async (task) => {
  const { toolName } = task.params as { toolName: string };

  // This will be implemented when the tool registry is ready
  logger.warn(`Custom tool execution not yet implemented: ${toolName}`);

  return {
    success: false,
    error: 'Custom tool execution not yet implemented',
  };
});
