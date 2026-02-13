/**
 * Session actor state types.
 * Each active session is represented by a SessionActor managed by the orchestrator.
 */

export type SessionStatus =
  | 'OPEN_IDLE'
  | 'OPEN_RUNNING'
  | 'OPEN_WAITING_USER'
  | 'OPEN_PAUSED'
  | 'CLOSED'
  | 'ERRORED';

export type WorkerState = 'starting' | 'ready' | 'busy' | 'dead';

export type WorkItemType =
  | 'USER_MESSAGE'
  | 'CANCEL'
  | 'CLOSE_SESSION'
  | 'STATUS_REQUEST';

export interface WorkItem {
  id: string;
  type: WorkItemType;
  eventId: string;
  sessionId: string;
  content: string;
  priority: 'high' | 'normal';
  createdAt: Date;
}

export interface WorkerHandle {
  pid: number;
  state: WorkerState;
  sessionId: string;
  process: import('child_process').ChildProcess;
}

export interface CurrentTask {
  taskId: string;
  userEventId: string;
  startedAt: Date;
  cancelRequested: boolean;
  cancelRequestedAt?: Date;
}

export interface SessionActor {
  sessionId: string;
  sessionName: string;
  sessionType: 'chat' | 'bot';
  status: SessionStatus;
  worker: WorkerHandle | null;
  currentTask: CurrentTask | null;
  queueHigh: WorkItem[];
  queueNormal: WorkItem[];
  projectPath: string;
  createdAt: Date;
  updatedAt: Date;
}
