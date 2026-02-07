/**
 * Task Orchestrator
 *
 * Executes a sequence of tasks, handling dependencies,
 * progress tracking, and error recovery.
 */

import { logger } from '../utils/logger';
import { executeTask } from './executor';
import type {
  Task,
  TaskContext,
  TaskResult,
  ExecuteOptions,
  OrchestratorResult,
} from './types';

/**
 * Run a list of tasks in sequence, respecting dependencies
 *
 * @param tasks - Tasks to execute
 * @param context - Execution context
 * @param options - Execution options
 * @returns Orchestrator result
 */
export async function runTasks(
  tasks: Task[],
  context: TaskContext,
  options: ExecuteOptions = {}
): Promise<OrchestratorResult> {
  const { onProgress, onError, stopOnFailure = true } = options;

  const results = new Map<string, TaskResult>();
  const errors: Array<{ taskId: string; error: string }> = [];

  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  logger.info(`Starting task orchestration: ${tasks.length} tasks`);

  // Build dependency graph
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const completed = new Set<string>();

  // Process tasks in order, checking dependencies
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    // Check if dependencies are met
    const depsOk = await checkDependencies(task, completed, taskMap, results);

    if (!depsOk) {
      logger.warn(`Skipping task [${task.id}]: dependencies not met`);
      task.status = 'skipped';
      skippedCount++;

      results.set(task.id, {
        success: false,
        error: 'Dependencies not met',
      });

      continue;
    }

    // Report progress
    if (onProgress) {
      onProgress(task, i, tasks.length);
    }

    // Execute the task
    task.status = 'running';
    task.startedAt = new Date();

    const result = await executeTask(task, {
      ...context,
      previousResults: results,
    });

    task.completedAt = new Date();
    task.result = result;
    results.set(task.id, result);

    if (result.success) {
      task.status = 'completed';
      completed.add(task.id);
      completedCount++;

      logger.info(`Task [${task.id}] completed successfully`);
    } else {
      task.status = 'failed';
      task.error = result.error;
      failedCount++;

      errors.push({ taskId: task.id, error: result.error ?? 'Unknown error' });

      logger.error(`Task [${task.id}] failed: ${result.error}`);

      if (onError) {
        onError(task, new Error(result.error));
      }

      if (stopOnFailure) {
        logger.warn('Stopping orchestration due to failure');

        // Mark remaining tasks as skipped
        for (let j = i + 1; j < tasks.length; j++) {
          tasks[j].status = 'skipped';
          skippedCount++;
          results.set(tasks[j].id, {
            success: false,
            error: 'Skipped due to previous failure',
          });
        }

        break;
      }
    }
  }

  const success = failedCount === 0;

  logger.info(
    `Orchestration complete: ${completedCount} completed, ${failedCount} failed, ${skippedCount} skipped`
  );

  return {
    success,
    completedTasks: completedCount,
    failedTasks: failedCount,
    skippedTasks: skippedCount,
    results,
    errors,
  };
}

/**
 * Check if a task's dependencies are met
 */
async function checkDependencies(
  task: Task,
  completed: Set<string>,
  taskMap: Map<string, Task>,
  results: Map<string, TaskResult>
): Promise<boolean> {
  if (!task.dependsOn || task.dependsOn.length === 0) {
    return true;
  }

  for (const depId of task.dependsOn) {
    // Check if dependency exists
    if (!taskMap.has(depId)) {
      logger.warn(`Task [${task.id}] has unknown dependency: ${depId}`);
      return false;
    }

    // Check if dependency completed successfully
    if (!completed.has(depId)) {
      return false;
    }

    const depResult = results.get(depId);
    if (!depResult?.success) {
      return false;
    }
  }

  return true;
}

/**
 * Create a simple task list from a prompt
 * This creates the standard task sequence for a Claude Code session
 *
 * @param sessionName - Name of the session
 * @param prompt - The enhanced prompt to send to Claude Code
 * @param projectPath - Optional project path
 * @returns List of tasks
 */
export function createStandardTaskList(
  sessionName: string,
  prompt: string,
  projectPath?: string
): Task[] {
  const baseId = `${sessionName}-${Date.now()}`;

  return [
    {
      id: `${baseId}-notify-start`,
      type: 'notify_user',
      description: 'Notify user that session is starting',
      status: 'pending',
      params: { message: `Starting session: ${sessionName}` },
    },
    {
      id: `${baseId}-claude-code`,
      type: 'claude_code',
      description: 'Execute prompt in Claude Code',
      status: 'pending',
      params: { prompt, projectPath },
      dependsOn: [`${baseId}-notify-start`],
      maxRetries: 2,
    },
    {
      id: `${baseId}-notify-complete`,
      type: 'notify_user',
      description: 'Notify user that session completed',
      status: 'pending',
      params: { message: `Session completed: ${sessionName}` },
      dependsOn: [`${baseId}-claude-code`],
    },
  ];
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(prefix = 'task'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
