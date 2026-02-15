/**
 * Session Actor Manager
 *
 * Manages the lifecycle of session actors and their worker processes.
 * Each session gets a dedicated long-lived worker child process.
 *
 * Responsibilities:
 * - Spawn/respawn worker processes
 * - Route work items to session queues (high priority for control, normal for messages)
 * - Dispatch next queued task when worker becomes ready
 * - Handle cancel escalation (SIGINT → SIGTERM → SIGKILL)
 * - Unload inactive sessions
 */

import { fork, type ChildProcess } from 'child_process';
import { sendIPC } from './ipc.js';
import type {
  OrchestratorToWorker,
  WorkerToOrchestrator,
} from './ipc-types.js';
import type {
  SessionActor,
  WorkItem,
  WorkerState,
} from './session-types.js';
import { Logger } from '../utils/logger.js';

export interface SessionActorManagerOptions {
  workspaceDir: string;
  workerScript: string;
  agentProvider?: string;
  agentModel?: string;
  utilityProvider?: string;
  utilityModel?: string;
  logger: Logger;
  onWorkerEvent: (sessionId: string, event: WorkerToOrchestrator) => void;
  onWorkerStateChange?: (sessionId: string, pid: number | null, state: WorkerState) => void;
}

export class SessionActorManager {
  private actors = new Map<string, SessionActor>();
  private options: SessionActorManagerOptions;
  private logger: Logger;

  constructor(options: SessionActorManagerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /**
   * Get or create a session actor. Spawns a worker if none is alive.
   */
  async getOrCreate(sessionId: string, meta: {
    sessionName: string;
    sessionType: 'chat' | 'bot';
    projectPath: string;
    persona?: string;
    model?: string;
  }): Promise<SessionActor> {
    let actor = this.actors.get(sessionId);

    if (!actor) {
      actor = {
        sessionId,
        sessionName: meta.sessionName,
        sessionType: meta.sessionType,
        status: 'OPEN_IDLE',
        worker: null,
        currentTask: null,
        queueHigh: [],
        queueNormal: [],
        projectPath: meta.projectPath,
        persona: meta.persona,
        model: meta.model,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.actors.set(sessionId, actor);
    }

    // Ensure worker is alive
    if (!actor.worker || actor.worker.state === 'dead') {
      await this.spawnWorker(actor);
    }

    return actor;
  }

  /**
   * Enqueue a work item for a session.
   */
  enqueue(sessionId: string, item: WorkItem): void {
    const actor = this.actors.get(sessionId);
    if (!actor) {
      this.logger.warn(`No actor for session ${sessionId}, dropping work item`);
      return;
    }

    if (item.priority === 'high') {
      actor.queueHigh.push(item);
    } else {
      actor.queueNormal.push(item);
    }

    actor.updatedAt = new Date();
    this.tryDispatch(actor);
  }

  /**
   * Get a session actor by ID (or undefined).
   */
  get(sessionId: string): SessionActor | undefined {
    return this.actors.get(sessionId);
  }

  /**
   * List all active session actors.
   */
  listActive(): SessionActor[] {
    return Array.from(this.actors.values()).filter(
      (a) => a.status.startsWith('OPEN_')
    );
  }

  /**
   * Close a session: cancel running tasks, terminate worker, mark closed.
   */
  async closeSession(sessionId: string): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) return;

    // Cancel any running task first
    if (actor.currentTask && actor.worker) {
      this.cancelCurrentTask(actor);
    }

    // Send WORKER_CLOSE
    if (actor.worker && actor.worker.state !== 'dead') {
      this.sendToWorker(actor, { type: 'WORKER_CLOSE', reason: 'session closed' });
      // Give it 3s to exit gracefully
      await this.waitForExit(actor.worker.process, 3000);
    }

    actor.status = 'CLOSED';
    actor.updatedAt = new Date();

    // Keep actor in map briefly for any final events, then unload
    setTimeout(() => {
      const a = this.actors.get(sessionId);
      if (a && a.status === 'CLOSED') {
        this.actors.delete(sessionId);
      }
    }, 10_000);
  }

  /**
   * Cancel the current task in a session (does not close the session).
   */
  cancelCurrentTask(actor: SessionActor): void {
    if (!actor.currentTask || !actor.worker) return;

    actor.currentTask.cancelRequested = true;
    actor.currentTask.cancelRequestedAt = new Date();

    // Step 1: soft cancel via IPC
    this.sendToWorker(actor, {
      type: 'WORKER_CANCEL',
      taskId: actor.currentTask.taskId,
    });

    // Step 2: SIGINT for PTY-based tools
    if (actor.worker.process.pid) {
      try {
        process.kill(actor.worker.process.pid, 'SIGINT');
      } catch { /* process may have already exited */ }
    }

    // Step 3: escalation timer
    const pid = actor.worker.process.pid;
    setTimeout(() => {
      // If task is still running after 4s, SIGTERM
      if (actor.currentTask?.cancelRequested && actor.worker?.state === 'busy') {
        this.logger.warn(`Cancel escalation: SIGTERM to worker ${pid}`);
        try { if (pid) process.kill(pid, 'SIGTERM'); } catch { /* */ }

        // Final escalation: SIGKILL after 3 more seconds
        setTimeout(() => {
          if (actor.worker?.state === 'busy') {
            this.logger.warn(`Cancel escalation: SIGKILL to worker ${pid}`);
            try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* */ }
            this.markWorkerDead(actor);
          }
        }, 3000);
      }
    }, 4000);
  }

  /**
   * Shutdown all sessions (for agent stop).
   */
  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.actors.keys()).map((id) =>
      this.closeSession(id)
    );
    await Promise.allSettled(promises);
    this.actors.clear();
  }

  /**
   * Steer a running task with additional user input.
   */
  steer(sessionId: string, prompt: string): void {
    const actor = this.actors.get(sessionId);
    if (!actor || !actor.worker || actor.worker.state !== 'busy') {
      this.logger.warn(`Cannot steer session ${sessionId}: not busy`);
      return;
    }
    this.sendToWorker(actor, { type: 'WORKER_STEER', prompt });
  }

  /**
   * Answer a question from the worker (tool asking for user input).
   */
  answer(sessionId: string, toolCallId: string, answerText: string): void {
    const actor = this.actors.get(sessionId);
    if (!actor || !actor.worker || actor.worker.state === 'dead') {
      this.logger.warn(`Cannot answer for session ${sessionId}: no live worker`);
      return;
    }
    this.sendToWorker(actor, { type: 'WORKER_ANSWER', toolCallId, answer: answerText });
    if (actor.status === 'OPEN_WAITING_USER') {
      actor.status = 'OPEN_RUNNING';
    }
  }

  // --- Private helpers ---

  private setWorkerState(actor: SessionActor, state: WorkerState): void {
    if (!actor.worker) return;
    actor.worker.state = state;
    this.options.onWorkerStateChange?.(
      actor.sessionId,
      state === 'dead' ? null : actor.worker.pid,
      state,
    );
  }

  private async spawnWorker(actor: SessionActor): Promise<void> {
    this.logger.info(`Spawning worker for session ${actor.sessionId}`);

    const child = fork(this.options.workerScript, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_OPTIONS: '--import tsx/esm',
      },
      silent: true, // pipe stdin/stdout/stderr
    });

    const workerPid = child.pid!;

    actor.worker = {
      pid: workerPid,
      state: 'starting', // set directly here since setWorkerState needs worker to exist
      sessionId: actor.sessionId,
      process: child,
    };
    this.options.onWorkerStateChange?.(actor.sessionId, workerPid, 'starting');

    // Pipe stderr to our logger
    child.stderr?.on('data', (data: Buffer) => {
      this.logger.debug(`[worker:${actor.sessionId}] ${data.toString().trim()}`);
    });

    // Listen for IPC messages from worker stdout
    this.listenToWorker(actor, child);

    // Handle unexpected exit
    child.on('exit', (code, signal) => {
      this.logger.warn(`Worker ${workerPid} exited (code=${code}, signal=${signal})`);
      this.markWorkerDead(actor);
    });

    // Send WORKER_INIT
    sendIPC(child.stdin!, {
      type: 'WORKER_INIT',
      sessionId: actor.sessionId,
      sessionName: actor.sessionName,
      sessionType: actor.sessionType,
      projectPath: actor.projectPath,
      workspaceDir: this.options.workspaceDir,
      persona: actor.persona,
      config: {
        agentProvider: this.options.agentProvider,
        agentModel: actor.model ?? this.options.agentModel,
        utilityProvider: this.options.utilityProvider,
        utilityModel: this.options.utilityModel,
      },
    });

    // Wait for WORKER_READY (with timeout)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 15_000);

      const checkReady = () => {
        if (actor.worker?.state === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (actor.worker?.state === 'dead') {
          clearTimeout(timeout);
          reject(new Error('Worker died during init'));
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  }

  private listenToWorker(actor: SessionActor, child: ChildProcess): void {
    if (!child.stdout) return;

    // Use a simple line-based parser
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as WorkerToOrchestrator;
          this.handleWorkerMessage(actor, msg);
        } catch {
          this.logger.debug(`[worker:${actor.sessionId}] non-JSON stdout: ${line.slice(0, 200)}`);
        }
      }
    });
  }

  private handleWorkerMessage(actor: SessionActor, msg: WorkerToOrchestrator): void {
    this.logger.verbose(`[worker:${actor.sessionId}] ${msg.type}`);

    switch (msg.type) {
      case 'WORKER_READY':
        this.setWorkerState(actor, 'ready');
        actor.status = 'OPEN_IDLE';
        this.tryDispatch(actor);
        break;

      case 'WORKER_TASK_STARTED':
        this.setWorkerState(actor, 'busy');
        actor.status = 'OPEN_RUNNING';
        break;

      case 'WORKER_TASK_DONE':
        actor.currentTask = null;
        this.setWorkerState(actor, 'ready');
        actor.status = 'OPEN_IDLE';
        // tryDispatch will be called when WORKER_READY follows
        break;

      case 'WORKER_TASK_CANCELLED':
        actor.currentTask = null;
        this.setWorkerState(actor, 'ready');
        actor.status = 'OPEN_IDLE';
        break;

      case 'WORKER_ERROR':
        if (msg.fatal) {
          this.markWorkerDead(actor);
        }
        break;

      case 'WORKER_PROGRESS':
        // Just forward to orchestrator callback
        break;

      case 'WORKER_STREAM_TEXT':
      case 'WORKER_TOOL_START':
      case 'WORKER_TOOL_END':
        // Forward to orchestrator for publishing to clients
        break;

      case 'WORKER_QUESTION':
        actor.status = 'OPEN_WAITING_USER';
        break;
    }

    // Forward all events to orchestrator for publishing/persistence
    this.options.onWorkerEvent(actor.sessionId, msg);
  }

  /**
   * Try to dispatch the next queued work item if the worker is ready.
   */
  private tryDispatch(actor: SessionActor): void {
    if (!actor.worker || actor.worker.state !== 'ready') return;
    if (actor.currentTask) return;

    // High priority first (Cancel, Close, Status)
    let item = actor.queueHigh.shift();
    if (!item) {
      item = actor.queueNormal.shift();
    }
    if (!item) return;

    // Handle control items inline
    if (item.type === 'CANCEL') {
      this.cancelCurrentTask(actor);
      return;
    }
    if (item.type === 'CLOSE_SESSION') {
      this.closeSession(actor.sessionId);
      return;
    }
    if (item.type === 'STATUS_REQUEST') {
      // Status is handled by orchestrator, not worker — just emit
      this.options.onWorkerEvent(actor.sessionId, {
        type: 'WORKER_READY',
        sessionId: actor.sessionId,
        pid: actor.worker.pid,
      });
      this.tryDispatch(actor); // continue to next item
      return;
    }

    // USER_MESSAGE → dispatch as task
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    actor.currentTask = {
      taskId,
      userEventId: item.eventId,
      startedAt: new Date(),
      cancelRequested: false,
    };

    this.sendToWorker(actor, {
      type: 'WORKER_TASK',
      taskId,
      userEventId: item.eventId,
      prompt: item.content,
    });
  }

  private sendToWorker(actor: SessionActor, msg: OrchestratorToWorker): void {
    if (!actor.worker || actor.worker.state === 'dead') {
      this.logger.warn(`Cannot send to dead worker for session ${actor.sessionId}`);
      return;
    }
    sendIPC(actor.worker.process.stdin!, msg);
  }

  private markWorkerDead(actor: SessionActor): void {
    this.setWorkerState(actor, 'dead');
    if (actor.currentTask) {
      actor.currentTask = null;
    }
    if (actor.status.startsWith('OPEN_')) {
      actor.status = 'ERRORED';
    }
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* */ }
        resolve();
      }, timeoutMs);

      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
