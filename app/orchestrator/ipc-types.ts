/**
 * IPC protocol between orchestrator and worker processes.
 * Communication is JSON Lines over stdin/stdout.
 */

// --- Orchestrator → Worker ---

export interface WorkerInitMessage {
  type: 'WORKER_INIT';
  sessionId: string;
  sessionName: string;
  sessionType: 'chat' | 'bot';
  projectPath: string;
  workspaceDir: string;
  config: {
    aiModel: string;
    anthropicApiKey?: string;
  };
}

export interface WorkerTaskMessage {
  type: 'WORKER_TASK';
  taskId: string;
  userEventId: string;
  prompt: string;
  context?: {
    chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    sessionName?: string;
    projectName?: string;
  };
}

export interface WorkerCancelMessage {
  type: 'WORKER_CANCEL';
  taskId: string;
  reason?: string;
}

export interface WorkerCloseMessage {
  type: 'WORKER_CLOSE';
  reason?: string;
}

export type OrchestratorToWorker =
  | WorkerInitMessage
  | WorkerTaskMessage
  | WorkerCancelMessage
  | WorkerCloseMessage;

// --- Worker → Orchestrator ---

export interface WorkerReadyMessage {
  type: 'WORKER_READY';
  sessionId: string;
  pid: number;
}

export interface WorkerTaskStartedMessage {
  type: 'WORKER_TASK_STARTED';
  taskId: string;
  sessionId: string;
}

export interface WorkerTaskDoneMessage {
  type: 'WORKER_TASK_DONE';
  taskId: string;
  sessionId: string;
  success: boolean;
  output?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
}

export interface WorkerTaskCancelledMessage {
  type: 'WORKER_TASK_CANCELLED';
  taskId: string;
  sessionId: string;
}

export interface WorkerErrorMessage {
  type: 'WORKER_ERROR';
  sessionId: string;
  error: string;
  fatal: boolean;
}

export interface WorkerProgressMessage {
  type: 'WORKER_PROGRESS';
  taskId: string;
  sessionId: string;
  message: string;
}

export type WorkerToOrchestrator =
  | WorkerReadyMessage
  | WorkerTaskStartedMessage
  | WorkerTaskDoneMessage
  | WorkerTaskCancelledMessage
  | WorkerErrorMessage
  | WorkerProgressMessage;

// Union of all IPC messages
export type IPCMessage = OrchestratorToWorker | WorkerToOrchestrator;
