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
    agentProvider?: string;
    agentModel?: string;
    utilityProvider?: string;
    utilityModel?: string;
    toolSet?: string;
    streaming?: boolean;
    preferAPIKeyClaude?: boolean;
    apiUrl: string;
    apiKey: string;
    personasDir: string;
    skillsDir: string;
  };
}

export interface WorkerTaskMessage {
  type: 'WORKER_TASK';
  taskId: string;
  userEventId: string;
  prompt: string;
  personaId?: string;
  personaVersionId?: string;
  model?: string;
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

export interface WorkerSteerMessage {
  type: 'WORKER_STEER';
  prompt: string;
}

export interface WorkerAnswerMessage {
  type: 'WORKER_ANSWER';
  toolCallId: string;
  answer: string;
}

export interface WorkerFormResponseMessage {
  type: 'WORKER_FORM_RESPONSE';
  sessionId: string;
  taskId: string;
  formId: string;
  response: import('../shared/form-types.js').FormResponseSubmitted | import('../shared/form-types.js').FormResponseCancelled;
}

export type OrchestratorToWorker =
  | WorkerInitMessage
  | WorkerTaskMessage
  | WorkerCancelMessage
  | WorkerCloseMessage
  | WorkerSteerMessage
  | WorkerAnswerMessage
  | WorkerFormResponseMessage;

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

export interface WorkerFileSendMessage {
  type: 'WORKER_FILE_SEND';
  taskId: string;
  sessionId: string;
  filename: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mimeType: string;
  sizeBytes: number;
}

export interface WorkerStreamTextMessage {
  type: 'WORKER_STREAM_TEXT';
  sessionId: string;
  taskId: string;
  delta: string;
}

export interface WorkerToolStartMessage {
  type: 'WORKER_TOOL_START';
  sessionId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
}

export interface WorkerToolEndMessage {
  type: 'WORKER_TOOL_END';
  sessionId: string;
  taskId: string;
  toolName: string;
  toolCallId: string;
  success: boolean;
  summary?: string;
}

export interface WorkerQuestionMessage {
  type: 'WORKER_QUESTION';
  sessionId: string;
  taskId: string;
  toolCallId: string;
  question: string;
  options?: string[];
}

export interface WorkerFormRequestMessage {
  type: 'WORKER_FORM_REQUEST';
  sessionId: string;
  taskId: string;
  formDefinition: import('../shared/form-types.js').FormDefinition;
}

export interface WorkerProjectSetMessage {
  type: 'WORKER_PROJECT_SET';
  sessionId: string;
  projectName: string;
  projectPath: string;
  isNew: boolean;
}

export type WorkerToOrchestrator =
  | WorkerReadyMessage
  | WorkerTaskStartedMessage
  | WorkerTaskDoneMessage
  | WorkerTaskCancelledMessage
  | WorkerErrorMessage
  | WorkerProgressMessage
  | WorkerFileSendMessage
  | WorkerStreamTextMessage
  | WorkerToolStartMessage
  | WorkerToolEndMessage
  | WorkerQuestionMessage
  | WorkerFormRequestMessage
  | WorkerProjectSetMessage;

// Union of all IPC messages
export type IPCMessage = OrchestratorToWorker | WorkerToOrchestrator;
