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

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentConfig } from '../config/index.js';
import { WebAppAdapter, PubNubAdapter } from '../messaging/index.js';
import type { PendingMessage } from '../shared/index.js';
import { getDb, closeDb } from '../db/index.js';
import { insertInbox, markProcessed, getUnprocessed } from '../db/inbox.js';
import { enqueueOutbox, getUnsent, markSent, markFailed } from '../db/outbox.js';
import {
  upsertSession,
  updateSessionStatus,
  getActiveSessions,
  insertSessionMessage,
} from '../db/sessions-db.js';
import { SessionActorManager } from './session-actor.js';
import type { WorkerToOrchestrator } from './ipc-types.js';
import type { WorkItem, WorkItemType } from './session-types.js';
import { HeartbeatScheduler } from '../scheduler/heartbeat.js';
import { Logger, logger } from '../utils/logger.js';
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

    // 2. Create session actor manager
    const workerScript = join(__dirname, 'worker.js');
    this.actorManager = new SessionActorManager({
      workspaceDir: this.config.workspace.baseDir,
      workerScript,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      aiModel: this.config.ai.model,
      logger: this.logger,
      onWorkerEvent: this.handleWorkerEvent.bind(this),
    });

    // 3. Verify connection
    try {
      const hb = await this.restAdapter.sendHeartbeat();
      this.logger.info(`Connected as agent: ${hb.agentId}`);
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
          logger: this.logger,
        });
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
      event_id: message.id,
      session_id: message.sessionId,
      session_type: message.sessionType || 'bot',
      content: message.content,
      session_name: message.sessionName ?? undefined,
    });

    if (!isNew) {
      this.logger.verbose(`Duplicate event ${message.id}, skipping`);
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
          event_id: msg.id,
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
        id: item.event_id,
        sessionId: item.session_id,
        sessionName: item.session_name ?? null,
        sessionType: (item.session_type as 'chat' | 'bot') || 'bot',
        content: item.content,
        createdAt: item.received_at,
      };
      // Fire-and-forget since these are recovery items
      this.routeMessage(msg).then(() => markProcessed(this.db, item.event_id));
    }
  }

  // --- Routing ---

  /**
   * Route a message to the appropriate session actor.
   * Derives intent (UI action or plain-text parsing) and enqueues a work item.
   */
  private async routeMessage(message: PendingMessage): Promise<void> {
    // Store in session messages table
    insertSessionMessage(this.db, message.sessionId, 'user', message.content, message.id);

    // Derive work item type
    const workItemType = this.deriveWorkItemType(message);

    // Ensure session exists in DB
    upsertSession(this.db, {
      sessionId: message.sessionId,
      sessionName: message.sessionName ?? undefined,
      sessionType: message.sessionType || 'bot',
      status: 'OPEN_IDLE',
    });

    // Determine project path
    const projectPath = this.config.workspace.baseDir;

    // Get or create actor (spawns worker if needed)
    const actor = await this.actorManager.getOrCreate(message.sessionId, {
      sessionName: message.sessionName ?? message.sessionId,
      sessionType: (message.sessionType as 'chat' | 'bot') || 'bot',
      projectPath,
    });

    // Enqueue work item
    const isControl = ['CANCEL', 'CLOSE_SESSION', 'STATUS_REQUEST'].includes(workItemType);
    const workItem: WorkItem = {
      id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: workItemType,
      eventId: message.id,
      sessionId: message.sessionId,
      content: message.content,
      priority: isControl ? 'high' : 'normal',
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
    const lower = message.content.toLowerCase().trim();

    if (lower === 'cancel' || lower === '/cancel') return 'CANCEL';
    if (lower === 'close' || lower === '/close' || lower === 'close session') return 'CLOSE_SESSION';
    if (lower === 'status' || lower === '/status') return 'STATUS_REQUEST';

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

      case 'WORKER_TASK_CANCELLED':
        this.publishEvent(sessionId, 'Task was cancelled.');
        updateSessionStatus(this.db, sessionId, 'OPEN_IDLE');
        break;

      case 'WORKER_ERROR':
        this.publishEvent(sessionId, `Error: ${event.error}`);
        if (event.fatal) {
          updateSessionStatus(this.db, sessionId, 'ERRORED');
        }
        break;

      case 'WORKER_TASK_STARTED':
        updateSessionStatus(this.db, sessionId, 'OPEN_RUNNING');
        break;

      case 'WORKER_READY':
        // No-op for publishing; actor manager handles dispatch
        break;

      case 'WORKER_PROGRESS':
        this.publishEvent(sessionId, event.message);
        break;
    }
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
        markFailed(this.db, item.id, error);
        this.logger.debug(`Outbox item ${item.id} failed: ${error}`);
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
            event_id: msg.id,
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
