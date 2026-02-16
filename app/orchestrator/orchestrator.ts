/**
 * Main Orchestrator
 *
 * Single process that owns:
 * - PubNub subscription (cmd channel) + publishing (evt channel)
 * - SQLite reads/writes (inbox, outbox, sessions)
 * - Session actor lifecycle and routing
 * - Outbox flush loop for REST persistence
 * - Heartbeat scheduling
 *
 * Replaces the old MiloAgent class.
 */

import { existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentConfig } from '../config/index.js';
import { WebAppAdapter, PubNubAdapter } from '../messaging/index.js';
import type { PubNubControlMessage } from '../messaging/pubnub-types.js';
import type { PendingMessage } from '../shared/index.js';
import { getDb, closeDb } from '../db/index.js';
import { insertInbox, markProcessed, getUnprocessed } from '../db/inbox.js';
import { enqueueOutbox, getUnsent, markSent, markFailed } from '../db/outbox.js';
import {
  upsertSession,
  updateSessionStatus,
  updateWorkerState,
  getActiveSessions,
  insertSessionMessage,
} from '../db/sessions-db.js';
import { SessionActorManager } from './session-actor.js';
import type { WorkerToOrchestrator } from './ipc-types.js';
import type { WorkItem, WorkItemType, WorkerState } from './session-types.js';
import { HeartbeatScheduler } from '../scheduler/heartbeat.js';
import { Logger, logger } from '../utils/logger.js';
import { getProviders, getModels, getEnvApiKey, registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface OrchestratorOptions {
  config: AgentConfig;
  apiKey?: string;
  debug?: boolean;
  verbose?: boolean;
}

export class Orchestrator {
  private config: AgentConfig;
  private logger: Logger;
  private db!: Database.Database;
  private restAdapter: WebAppAdapter;
  private pubnubAdapter: PubNubAdapter | null = null;
  private actorManager!: SessionActorManager;
  private scheduler: HeartbeatScheduler;
  private outboxTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private shuttingDown = false;
  private orphanMonitors = new Map<string, NodeJS.Timeout>();
  private orphanedSessionIds = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.config = options.config;

    if (options.apiKey) {
      process.env.MILO_API_KEY = options.apiKey;
    }

    const logLevel = options.debug ? 'debug' : options.verbose ? 'verbose' : 'info';
    this.logger = new Logger({ level: logLevel, prefix: `[${this.config.agentName}]` });
    logger.setLevel(logLevel);

    this.restAdapter = new WebAppAdapter({
      apiUrl: this.config.messaging.webapp.apiUrl,
      apiKey: process.env.MILO_API_KEY || '',
    });

    this.scheduler = new HeartbeatScheduler({
      intervalMinutes: this.config.scheduler.heartbeatIntervalMinutes,
      onHeartbeat: this.handleHeartbeat.bind(this),
    });

    this.setupShutdownHandlers();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.logger.info('Starting orchestrator...');

    // 1. Open SQLite
    this.db = getDb(this.config.workspace.baseDir);
    this.logger.verbose('SQLite database opened');

    // 1b. Recover orphaned sessions from prior crash
    this.recoverOrphanedSessions();

    // 2. Create session actor manager
    const workerScript = join(__dirname, '..', 'orchestrator', 'worker.js');
    this.actorManager = new SessionActorManager({
      workspaceDir: this.config.workspace.baseDir,
      workerScript,
      agentProvider: this.config.ai.agent.provider,
      agentModel: this.config.ai.agent.model,
      utilityProvider: this.config.ai.utility.provider,
      utilityModel: this.config.ai.utility.model,
      streaming: this.config.streaming,
      apiUrl: this.config.messaging.webapp.apiUrl,
      apiKey: process.env.MILO_API_KEY || '',
      personasDir: join(this.config.workspace.baseDir, this.config.workspace.personasDir),
      skillsDir: join(this.config.workspace.baseDir, this.config.workspace.skillsDir),
      logger: this.logger,
      onWorkerEvent: this.handleWorkerEvent.bind(this),
      onWorkerStateChange: (sessionId: string, pid: number | null, state: WorkerState) => {
        updateWorkerState(this.db, sessionId, pid, state);
      },
    });

    // 3. Verify connection and sync models
    try {
      const hb = await this.restAdapter.sendHeartbeat();
      this.logger.info(`Connected as agent: ${hb.agentId}`);
      await this.syncModelsToServer();
    } catch (err) {
      this.logger.warn('Could not reach server, will retry:', err);
    }

    // 4. Connect PubNub if enabled
    if (this.config.pubnub.enabled) {
      try {
        this.pubnubAdapter = new PubNubAdapter({
          apiUrl: this.config.messaging.webapp.apiUrl,
          apiKey: process.env.MILO_API_KEY || '',
          onMessage: this.handlePubNubMessage.bind(this),
          onControl: this.handlePubNubControl.bind(this),
          logger: this.logger,
        });
        this.pubnubAdapter.pubsubOnly = true; // Orchestrator manages REST persistence via outbox
        await this.pubnubAdapter.connect();
        await this.pubnubAdapter.publishAgentStatus('Bot is online');
        this.scheduler.setInterval(5);
        this.logger.info('PubNub connected');
      } catch (err) {
        this.logger.warn('PubNub failed, falling back to polling:', err);
        this.pubnubAdapter = null;
      }
    }

    // 5. Catch up on missed messages
    await this.catchUpMessages();

    // 6. Process any unprocessed inbox items (from prior crash)
    this.drainInbox();

    // 7. Start heartbeat + outbox flush
    this.scheduler.start();
    this.outboxTimer = setInterval(() => this.flushOutbox(), 10_000);

    this.isRunning = true;
    this.logger.info('Orchestrator started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning || this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.info('Stopping orchestrator...');

    if (this.pubnubAdapter) {
      await this.pubnubAdapter.publishAgentStatus('Bot is signing off');
      await this.pubnubAdapter.disconnect();
    }

    if (this.outboxTimer) clearInterval(this.outboxTimer);

    // Clean up orphan monitors
    for (const timer of this.orphanMonitors.values()) {
      clearInterval(timer);
    }
    this.orphanMonitors.clear();
    this.orphanedSessionIds.clear();

    // Audit log shutdown for active sessions
    const activeSessions = getActiveSessions(this.db);
    for (const session of activeSessions) {
      insertSessionMessage(this.db, session.session_id, 'system', 'Orchestrator shutting down');
    }

    await this.actorManager.shutdownAll();

    // Final outbox flush
    await this.flushOutbox();

    this.scheduler.stop();
    closeDb();

    this.isRunning = false;
    this.logger.info('Orchestrator stopped');
  }

  // --- Ingest ---

  /**
   * Handle a message from PubNub (real-time path).
   * Ingest-first: dedup → inbox → fast receipt → route.
   */
  private async handlePubNubMessage(message: PendingMessage): Promise<void> {
    this.logger.info(`PubNub message: ${message.id}`);

    // 1. Dedup + persist to inbox
    const isNew = insertInbox(this.db, {
      message_id: message.id,
      session_id: message.sessionId,
      session_type: message.sessionType || 'bot',
      content: message.content,
      session_name: message.sessionName ?? undefined,
      ui_action: message.uiAction ?? undefined,
    });

    if (!isNew) {
      this.logger.verbose(`Duplicate message ${message.id}, skipping`);
      return;
    }

    // 2. Publish fast receipt
    if (this.pubnubAdapter) {
      await this.pubnubAdapter.sendMessage('Message received. Processing...', message.sessionId);
    }

    // 3. Enqueue REST ack in outbox
    enqueueOutbox(this.db, 'ack_message', { messageIds: [message.id] }, message.sessionId);

    // 4. Route to session
    await this.routeMessage(message);

    // 5. Mark inbox processed
    markProcessed(this.db, message.id);
  }

  /**
   * Handle a control message from PubNub (non-user_message types).
   * These are server-initiated commands like session deletion.
   */
  private async handlePubNubControl(message: PubNubControlMessage): Promise<void> {
    this.logger.info(`PubNub control: ${message.type} (ui_action=${message.ui_action})`);

    if (message.ui_action === 'DELETE_SESSION' || message.type === 'session_deleted') {
      await this.handleDeleteSession(message.sessionId, message.sessionName);
    } else {
      this.logger.verbose(`Unhandled control message type: ${message.type}`);
    }
  }

  /**
   * Handle session deletion: stop worker, update DB, remove session file.
   */
  private async handleDeleteSession(sessionId: string, sessionName?: string): Promise<void> {
    this.logger.info(`Deleting session ${sessionId} (name=${sessionName})`);

    // 1. Close session actor (cancel tasks, stop worker process)
    await this.actorManager.closeSession(sessionId);

    // 2. Update session status in SQLite
    updateSessionStatus(this.db, sessionId, 'CLOSED');
    insertSessionMessage(this.db, sessionId, 'system', 'Session deleted by user');

    // 3. Delete session file from SESSIONS directory
    if (sessionName) {
      const sessionsDir = join(this.config.workspace.baseDir, this.config.workspace.sessionsDir);
      const sessionFile = join(sessionsDir, `${sessionName}.md`);
      try {
        if (existsSync(sessionFile)) {
          unlinkSync(sessionFile);
          this.logger.info(`Deleted session file: ${sessionFile}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to delete session file ${sessionFile}:`, err);
      }
    }

    this.logger.info(`Session ${sessionId} deleted`);
  }

  /**
   * Catch up on messages missed while offline (REST fetch).
   */
  private async catchUpMessages(): Promise<void> {
    try {
      const pending = await this.restAdapter.getPendingMessages();
      if (pending.length === 0) return;

      this.logger.info(`Catching up on ${pending.length} missed messages`);
      for (const msg of pending) {
        // Dedup via inbox
        const isNew = insertInbox(this.db, {
          message_id: msg.id,
          session_id: msg.sessionId,
          session_type: msg.sessionType || 'bot',
          content: msg.content,
          session_name: msg.sessionName ?? undefined,
        });
        if (isNew) {
          await this.routeMessage(msg);
          markProcessed(this.db, msg.id);
        }
      }
      await this.restAdapter.acknowledgeMessages(pending.map((m) => m.id));
    } catch (err) {
      this.logger.warn('Catch-up failed:', err);
    }
  }

  /**
   * Drain any unprocessed inbox items (crash recovery).
   */
  private drainInbox(): void {
    const items = getUnprocessed(this.db);
    if (items.length === 0) return;

    this.logger.info(`Draining ${items.length} unprocessed inbox items`);
    for (const item of items) {
      const msg: PendingMessage = {
        id: item.message_id,
        sessionId: item.session_id,
        sessionName: item.session_name ?? null,
        sessionType: (item.session_type as 'chat' | 'bot') || 'bot',
        content: item.content,
        createdAt: item.received_at,
      };
      // Fire-and-forget since these are recovery items
      this.routeMessage(msg).then(() => markProcessed(this.db, item.message_id));
    }
  }

  // --- Routing ---

  /**
   * Route a message to the appropriate session actor.
   * Derives intent (UI action or plain-text parsing) and enqueues a work item.
   */
  private async routeMessage(message: PendingMessage): Promise<void> {
    // Skip routing if session is orphaned (message stays unprocessed, will be drained when orphan exits)
    if (this.orphanedSessionIds.has(message.sessionId)) {
      this.logger.verbose(`Session ${message.sessionId} is orphaned, deferring message`);
      return;
    }

    // Ensure session exists in DB (must come before insertSessionMessage due to FK constraint)
    upsertSession(this.db, {
      sessionId: message.sessionId,
      sessionName: message.sessionName ?? undefined,
      sessionType: message.sessionType || 'bot',
      status: 'OPEN_IDLE',
    });

    // Store in session messages table
    insertSessionMessage(this.db, message.sessionId, 'user', message.content, message.id);

    // Derive work item type
    const workItemType = this.deriveWorkItemType(message);

    // LIST_MODELS doesn't need a session/worker — handle inline
    if (workItemType === 'LIST_MODELS') {
      const { text, structured } = this.getAvailableModels();
      this.publishModelsList(message.sessionId, structured, text);
      enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: text }, message.sessionId);
      this.syncModelsToServer();
      return;
    }

    // Determine project path
    const projectPath = this.config.workspace.baseDir;

    // Get or create actor (spawns worker if needed)
    const actor = await this.actorManager.getOrCreate(message.sessionId, {
      sessionName: message.sessionName ?? message.sessionId,
      sessionType: (message.sessionType as 'chat' | 'bot') || 'bot',
      projectPath,
    });

    // If the actor is busy with a task and this is a normal message, steer instead of queue
    if (workItemType === 'USER_MESSAGE' && actor.status === 'OPEN_RUNNING') {
      this.actorManager.steer(message.sessionId, message.content);
      this.logger.verbose(`Steered running session ${message.sessionId}`);
      return;
    }

    // If the actor is waiting for an answer and this is a normal message, answer
    if (workItemType === 'USER_MESSAGE' && actor.status === 'OPEN_WAITING_USER' && actor.currentTask) {
      // Find the pending question's toolCallId from the last WORKER_QUESTION event
      // For simplicity, use the message content as the answer for the current task
      // The worker tracks pending answers by toolCallId
      this.actorManager.answer(message.sessionId, '', message.content);
      this.logger.verbose(`Answered waiting session ${message.sessionId}`);
      return;
    }

    // Enqueue work item
    const isControl = ['CANCEL', 'CLOSE_SESSION', 'STATUS_REQUEST', 'LIST_MODELS'].includes(workItemType);
    const workItem: WorkItem = {
      id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: workItemType,
      eventId: message.id,
      sessionId: message.sessionId,
      content: message.content,
      priority: isControl ? 'high' : 'normal',
      personaId: message.personaId,
      personaVersionId: message.personaVersionId,
      model: message.model,
      createdAt: new Date(),
    };

    this.actorManager.enqueue(message.sessionId, workItem);
    this.logger.verbose(`Enqueued ${workItemType} for session ${message.sessionId} (actor status: ${actor.status})`);
  }

  /**
   * Derive the internal WorkItemType from a message.
   * UI actions take precedence, then pattern matching.
   */
  private deriveWorkItemType(message: PendingMessage): WorkItemType {
    // UI actions take precedence (case-insensitive)
    const action = message.uiAction?.toUpperCase();
    if (action === 'CANCEL') return 'CANCEL';
    if (action === 'CLOSE_SESSION') return 'CLOSE_SESSION';
    if (action === 'STATUS_REQUEST') return 'STATUS_REQUEST';
    if (action === 'LIST_MODELS') return 'LIST_MODELS';

    // Text pattern matching fallback
    const lower = message.content.toLowerCase().trim();

    if (lower === 'cancel' || lower === '/cancel') return 'CANCEL';
    if (lower === 'close' || lower === '/close' || lower === 'close session') return 'CLOSE_SESSION';
    if (lower === 'status' || lower === '/status') return 'STATUS_REQUEST';
    if (lower === '/models' || lower === 'models') return 'LIST_MODELS';

    // Default: user message (the worker handles the specifics)
    return 'USER_MESSAGE';
  }

  // --- Worker Events ---

  /**
   * Handle events from worker processes.
   * Publish via PubNub and enqueue for REST persistence.
   */
  private handleWorkerEvent(sessionId: string, event: WorkerToOrchestrator): void {
    switch (event.type) {
      case 'WORKER_TASK_DONE': {
        // Save agent response to session messages
        if (event.output) {
          insertSessionMessage(this.db, sessionId, 'agent', event.output);
        }

        // Audit log task failures
        if (!event.success) {
          insertSessionMessage(this.db, sessionId, 'system', `Task failed: ${event.error ?? 'Unknown error'}`);
        }

        // Publish to user
        const content = event.success
          ? event.output ?? 'Task completed.'
          : `Error: ${event.error ?? 'Unknown error'}`;
        this.publishEvent(sessionId, content);

        // Update session status in DB
        updateSessionStatus(this.db, sessionId, 'OPEN_IDLE');

        // Enqueue for REST persistence
        enqueueOutbox(this.db, 'send_message', {
          sessionId,
          content,
        }, sessionId);
        break;
      }

      case 'WORKER_TASK_CANCELLED': {
        const cancelContent = 'Task was cancelled.';
        this.publishEvent(sessionId, cancelContent);
        updateSessionStatus(this.db, sessionId, 'OPEN_IDLE');
        enqueueOutbox(this.db, 'send_message', { sessionId, content: cancelContent }, sessionId);
        break;
      }

      case 'WORKER_ERROR': {
        const errorContent = `Error: ${event.error}`;
        this.publishEvent(sessionId, errorContent);
        enqueueOutbox(this.db, 'send_message', { sessionId, content: errorContent }, sessionId);
        if (event.fatal) {
          insertSessionMessage(this.db, sessionId, 'system', `Worker error (fatal): ${event.error}`);
          updateSessionStatus(this.db, sessionId, 'ERRORED');
        }
        break;
      }

      case 'WORKER_TASK_STARTED':
        updateSessionStatus(this.db, sessionId, 'OPEN_RUNNING');
        break;

      case 'WORKER_READY':
        // No-op for publishing; actor manager handles dispatch
        break;

      case 'WORKER_PROGRESS':
        this.publishEvent(sessionId, event.message);
        break;

      case 'WORKER_STREAM_TEXT':
        // Real-time text streaming — publish to user via PubNub (if enabled)
        if (this.config.streaming) {
          this.publishEvent(sessionId, event.delta);
        }
        break;

      case 'WORKER_TOOL_START':
        this.publishEvent(sessionId, `Using tool: ${event.toolName}...`);
        break;

      case 'WORKER_TOOL_END':
        // Only publish tool end if it failed
        if (!event.success) {
          this.publishEvent(sessionId, `Tool ${event.toolName} failed: ${event.summary ?? 'unknown error'}`);
        }
        break;

      case 'WORKER_QUESTION':
        updateSessionStatus(this.db, sessionId, 'OPEN_WAITING_USER');
        this.publishEvent(sessionId, event.question);
        insertSessionMessage(this.db, sessionId, 'agent', event.question);
        enqueueOutbox(this.db, 'send_message', { sessionId, content: event.question }, sessionId);
        break;
    }
  }

  // --- Models ---

  /**
   * Get available models as both formatted text and structured data.
   */
  private getAvailableModels(): {
    text: string;
    structured: {
      defaultModel?: string;
      providers: Array<{ provider: string; models: Array<{ id: string; name: string }> }>;
    };
  } {
    registerBuiltInApiProviders();
    const allProviders = getProviders();
    const lines: string[] = ['Available Models:'];

    const defaultModel = this.config.ai.agent.model || this.config.ai.utility.model;
    if (defaultModel) {
      lines.push(`\nDefault model: ${defaultModel}`);
    }

    const structuredProviders: Array<{ provider: string; models: Array<{ id: string; name: string }> }> = [];

    for (const provider of allProviders) {
      const envKey = getEnvApiKey(provider);
      if (!envKey) continue;

      try {
        const models = getModels(provider);
        if (models.length === 0) continue;

        lines.push(`\n${provider}:`);
        const providerModels: Array<{ id: string; name: string }> = [];
        for (const model of models) {
          lines.push(`  - ${model.name} (${model.id})`);
          providerModels.push({ id: model.id, name: model.name });
        }
        structuredProviders.push({ provider, models: providerModels });
      } catch {
        // Skip providers that fail
      }
    }

    if (structuredProviders.length === 0) {
      lines.push('\nNo API keys configured. Run `milo init` to add provider keys.');
    }

    return {
      text: lines.join('\n'),
      structured: {
        defaultModel: defaultModel || undefined,
        providers: structuredProviders,
      },
    };
  }

  /**
   * Sync available models to the web app database so the UI can display them after page refresh.
   * Fire-and-forget — failures are logged but don't block the caller.
   */
  private syncModelsToServer(): void {
    const { structured } = this.getAvailableModels();
    const models = structured.providers.flatMap((p) =>
      p.models.map((m) => ({ provider: p.provider, modelId: m.id, displayName: m.name }))
    );

    this.restAdapter.syncModels(models).then(() => {
      this.logger.verbose(`Synced ${models.length} models to server`);
    }).catch((err) => {
      this.logger.warn('Failed to sync models to server:', err);
    });
  }

  // --- Publishing ---

  /**
   * Publish an event to the user via PubNub (single publisher).
   */
  private publishEvent(sessionId: string, content: string): void {
    if (this.pubnubAdapter?.isConnected) {
      this.pubnubAdapter.sendMessage(content, sessionId).catch((err) => {
        this.logger.warn('PubNub publish failed:', err);
      });
    }
  }

  /**
   * Publish a structured models list to the user via PubNub.
   */
  private publishModelsList(
    sessionId: string,
    models: { defaultModel?: string; providers: Array<{ provider: string; models: Array<{ id: string; name: string }> }> },
    text: string,
  ): void {
    if (this.pubnubAdapter?.isConnected) {
      this.pubnubAdapter.publishModelsList(sessionId, models, text).catch((err) => {
        this.logger.warn('PubNub models list publish failed:', err);
      });
    }
  }

  // --- Outbox Flush ---

  /**
   * Flush unsent outbox items to the REST API.
   */
  private async flushOutbox(): Promise<void> {
    const items = getUnsent(this.db);
    if (items.length === 0) return;

    this.logger.verbose(`Flushing ${items.length} outbox items`);

    for (const item of items) {
      try {
        const payload = JSON.parse(item.payload);

        switch (item.event_type) {
          case 'ack_message':
            await this.restAdapter.acknowledgeMessages(payload.messageIds);
            break;
          case 'send_message':
            await this.restAdapter.sendMessage(payload.content, payload.sessionId);
            break;
          default:
            this.logger.warn(`Unknown outbox event type: ${item.event_type}`);
        }

        markSent(this.db, item.id);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Permanent failures (404 = session deleted, 401 = bad auth) — skip retries
        const isPermanent = /API error \(40[134]\)/.test(error);
        if (isPermanent) {
          markSent(this.db, item.id); // Mark as "sent" to stop retrying
          this.logger.debug(`Outbox item ${item.id} permanently failed (${error}), skipping`);
        } else {
          markFailed(this.db, item.id, error);
          this.logger.debug(`Outbox item ${item.id} failed: ${error}`);
        }
      }
    }
  }

  // --- Heartbeat ---

  private async handleHeartbeat(): Promise<void> {
    try {
      const activeSessions = getActiveSessions(this.db);
      const names = activeSessions.map((s) => s.session_name ?? s.session_id);
      await this.restAdapter.sendHeartbeat(names);

      // If no PubNub, poll for messages
      if (!this.pubnubAdapter?.isConnected) {
        const pending = await this.restAdapter.getPendingMessages();
        for (const msg of pending) {
          const isNew = insertInbox(this.db, {
            message_id: msg.id,
            session_id: msg.sessionId,
            session_type: msg.sessionType || 'bot',
            content: msg.content,
            session_name: msg.sessionName ?? undefined,
          });
          if (isNew) {
            await this.routeMessage(msg);
            markProcessed(this.db, msg.id);
          }
        }
        if (pending.length > 0) {
          await this.restAdapter.acknowledgeMessages(pending.map((m) => m.id));
        }
      }
    } catch (err) {
      this.logger.error('Heartbeat failed:', err);
    }
  }

  // --- Orphan Recovery ---

  /**
   * On startup, detect sessions left in an active state by a prior crash.
   * For each, check if the worker PID is still alive:
   * - Alive → mark as orphaned, poll until it exits
   * - Dead/null → mark session CLOSED
   */
  private recoverOrphanedSessions(): void {
    const sessions = getActiveSessions(this.db);
    if (sessions.length === 0) return;

    this.logger.info(`Recovering ${sessions.length} active session(s) from prior run`);

    for (const session of sessions) {
      const pid = session.worker_pid ?? null;

      if (pid && this.isProcessAlive(pid)) {
        this.logger.warn(`Session ${session.session_id}: worker PID ${pid} still alive (orphaned)`);
        this.orphanedSessionIds.add(session.session_id);
        this.monitorOrphanedPid(session.session_id, pid);
        insertSessionMessage(
          this.db,
          session.session_id,
          'system',
          `Orchestrator restarted. Orphaned worker PID ${pid} detected — monitoring until exit.`,
        );
      } else {
        this.logger.info(`Session ${session.session_id}: worker PID ${pid ?? 'none'} is dead, closing session`);
        updateSessionStatus(this.db, session.session_id, 'CLOSED');
        updateWorkerState(this.db, session.session_id, null, 'dead');
        insertSessionMessage(
          this.db,
          session.session_id,
          'system',
          `Orchestrator restarted. Prior worker ${pid ? `PID ${pid}` : '(no PID)'} is dead — session closed.`,
        );
      }
    }
  }

  /**
   * Check if a process is still alive via kill(pid, 0).
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      // EPERM means the process exists but we lack permission (still alive)
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EPERM') {
        return true;
      }
      // ESRCH means no such process
      return false;
    }
  }

  /**
   * Poll an orphaned worker PID every 10s. When it exits,
   * close the session and drain the inbox to reprocess queued messages.
   */
  private monitorOrphanedPid(sessionId: string, pid: number): void {
    const timer = setInterval(() => {
      if (!this.isProcessAlive(pid)) {
        this.logger.info(`Orphaned worker PID ${pid} for session ${sessionId} has exited`);
        clearInterval(timer);
        this.orphanMonitors.delete(sessionId);
        this.orphanedSessionIds.delete(sessionId);

        updateSessionStatus(this.db, sessionId, 'CLOSED');
        updateWorkerState(this.db, sessionId, null, 'dead');
        insertSessionMessage(
          this.db,
          sessionId,
          'system',
          `Orphaned worker PID ${pid} exited. Session closed.`,
        );

        // Reprocess any messages that were deferred while orphaned
        this.drainInbox();
      }
    }, 10_000);

    this.orphanMonitors.set(sessionId, timer);
  }

  // --- Shutdown ---

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.logger.info(`Received ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // --- Status ---

  getStatus() {
    return {
      running: this.isRunning,
      activeSessions: this.actorManager?.listActive().length ?? 0,
    };
  }
}
