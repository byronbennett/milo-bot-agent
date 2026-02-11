/**
 * Task Types
 *
 * Types for the task execution system.
 */

/**
 * Types of tasks the orchestrator can execute
 */
export type TaskType =
  | 'claude_code'    // Send prompt to Claude Code
  | 'file_create'    // Create a file
  | 'file_read'      // Read a file
  | 'file_write'     // Write to a file
  | 'file_delete'    // Delete a file
  | 'git_init'       // Initialize git repo
  | 'git_commit'     // Create a commit
  | 'git_push'       // Push to remote
  | 'shell'          // Run shell command
  | 'notify_user'    // Send message to user
  | 'wait'           // Wait for a duration
  | 'custom';        // Custom tool execution

/**
 * Status of a task
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

/**
 * A task to be executed
 */
export interface Task {
  id: string;
  type: TaskType;
  description: string;
  status: TaskStatus;
  params: Record<string, unknown>;
  dependsOn?: string[]; // IDs of tasks that must complete first
  retryCount?: number;
  maxRetries?: number;
  result?: TaskResult;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

/**
 * Result of task execution
 */
export interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Task execution context
 */
export interface TaskContext {
  sessionId: string;
  sessionName: string;
  projectPath?: string;
  workspaceDir: string;
  previousResults: Map<string, TaskResult>;
}

/**
 * Task handler function type
 */
export type TaskHandler = (
  task: Task,
  context: TaskContext
) => Promise<TaskResult>;

/**
 * Options for task execution
 */
export interface ExecuteOptions {
  onProgress?: (task: Task, index: number, total: number) => void;
  onError?: (task: Task, error: Error) => void;
  stopOnFailure?: boolean;
}

/**
 * Result of orchestrator run
 */
export interface OrchestratorResult {
  success: boolean;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  results: Map<string, TaskResult>;
  errors: Array<{ taskId: string; error: string }>;
}
