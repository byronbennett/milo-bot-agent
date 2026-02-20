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

import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentConfig } from '../config/index.js';
import { WebAppAdapter, PubNubAdapter } from '../messaging/index.js';
import type { PubNubControlMessage, PubNubSkillCommand, PubNubFormResponseCommand } from '../messaging/pubnub-types.js';
import { SkillInstaller } from '../skills/skill-installer.js';
import type { PendingMessage } from '../shared/index.js';
import { getDb, closeDb } from '../db/index.js';
import { insertInbox, markProcessed, getUnprocessed } from '../db/inbox.js';
import { enqueueOutbox, getUnsent, markSent, markFailed } from '../db/outbox.js';
import {
  upsertSession,
  updateSessionStatus,
  updateWorkerState,
  updateConfirmedProject,
  getActiveSessions,
  getConfirmedProject,
  insertSessionMessage,
} from '../db/sessions-db.js';
import { SessionActorManager } from './session-actor.js';
import { getPackageRoot, detectInstallMethod, getCurrentVersion, getLatestVersion, spawnUpdateDaemon, UPDATE_CHECK_INTERVAL_MS, type InstallMethod } from './updater.js';
import type { WorkerToOrchestrator } from './ipc-types.js';
import type { WorkItem, WorkItemType, WorkerState } from './session-types.js';
import { HeartbeatScheduler } from '../scheduler/heartbeat.js';
import { Logger, logger } from '../utils/logger.js';
import { getProviders, getModels, getEnvApiKey, registerBuiltInApiProviders } from '@mariozechner/pi-ai';
import type Database from 'better-sqlite3';
import { loadTools, type ToolContext } from '../agent-tools/index.js';
import { discoverSkills } from '../skills/skills-registry.js';
import { getCuratedAllowList, invalidateCuratedCache } from '../models/curated-models.js';
import { detectLocalModels } from '../models/local-models.js';

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
  private startedAt: Date | null = null;
  private shuttingDown = false;
  private orphanMonitors = new Map<string, NodeJS.Timeout>();
  private orphanedSessionIds = new Set<string>();
  private pendingForms = new Map<string, { formId: string; sessionId: string; taskId: string }>();
  private skillInstaller!: SkillInstaller;
  private agentId: string = '';
  private currentVersion: string = 'unknown';
  private latestVersion: string = 'unknown';
  private needsUpdate = false;
  private installMethod: InstallMethod = 'git';
  private updateCheckTimer: NodeJS.Timeout | null = null;

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
    this.startedAt = new Date();

    this.logger.info('Starting orchestrator...');

    // 1. Open SQLite
    this.db = getDb(this.config.workspace.baseDir);
    this.logger.verbose('SQLite database opened');

    // Ensure PROJECTS directory exists
    const projectsDir = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
    mkdirSync(projectsDir, { recursive: true });

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
      preferAPIKeyClaude: this.config.claudeCode.preferAPIKey,
      apiUrl: this.config.messaging.webapp.apiUrl,
      apiKey: process.env.MILO_API_KEY || '',
      personasDir: join(this.config.workspace.baseDir, this.config.workspace.personasDir),
      skillsDir: join(this.config.workspace.baseDir, this.config.workspace.skillsDir),
      logger: this.logger,
      onWorkerEvent: this.handleWorkerEvent.bind(this),
      onWorkerStateChange: (sessionId: string, pid: number | null, state: WorkerState) => {
        updateWorkerState(this.db, sessionId, pid, state);
        if (state === 'dead') {
          this.cleanupPendingForms(sessionId);
        }
      },
    });

    // 2b. Create skill installer
    this.skillInstaller = new SkillInstaller({
      skillsDir: join(this.config.workspace.baseDir, this.config.workspace.skillsDir),
      apiUrl: this.config.messaging.webapp.apiUrl,
      apiKey: process.env.MILO_API_KEY || '',
      logger: this.logger,
    });

    // 3. Verify connection and sync models
    try {
      const hb = await this.restAdapter.sendHeartbeat();
      this.agentId = hb.agentId;
      this.logger.info(`Connected as agent: ${hb.agentId}`);
      await this.syncModelsToServer();
    } catch (err) {
      const apiUrl = this.config.messaging.webapp.apiUrl;
      this.logger.warn(`Could not reach server at ${apiUrl}:`, err);
      if (!this.isDefaultServerUrl(apiUrl)) {
        this.logger.warn(
          'You are using a custom server URL. If you intended to connect to the official MiloBot server, run `milo init` and set the server URL to https://www.milobot.dev'
        );
      }
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

    // 8. Detect version and start update checker
    const packageRoot = getPackageRoot();
    this.installMethod = detectInstallMethod(packageRoot);
    this.currentVersion = getCurrentVersion(packageRoot, this.installMethod);
    this.logger.info(`Agent version: ${this.currentVersion} (${this.installMethod})`);

    // Run first check immediately, then hourly
    this.checkForUpdates().catch((err) => this.logger.verbose('Initial update check failed:', err));
    this.updateCheckTimer = setInterval(() => {
      this.checkForUpdates().catch((err) => this.logger.verbose('Periodic update check failed:', err));
    }, UPDATE_CHECK_INTERVAL_MS);
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
    if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);

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

    // Handle form responses from browser
    if (message.type === 'form_response') {
      const formMsg = message as unknown as PubNubFormResponseCommand;
      const pending = this.pendingForms.get(formMsg.formId);
      if (!pending) {
        this.logger.warn(`Received form_response for unknown formId: ${formMsg.formId}`);
        return;
      }
      // Clear pending form
      this.pendingForms.delete(formMsg.formId);
      // Forward to worker
      this.actorManager.sendFormResponse(pending.sessionId, {
        type: 'WORKER_FORM_RESPONSE',
        sessionId: pending.sessionId,
        taskId: pending.taskId,
        formId: formMsg.formId,
        response: formMsg.status === 'submitted'
          ? { formId: formMsg.formId, status: 'submitted' as const, values: formMsg.values ?? {} }
          : { formId: formMsg.formId, status: 'cancelled' as const },
      });
      // Update session status
      const newStatus = formMsg.status === 'submitted' ? 'OPEN_RUNNING' : 'OPEN_IDLE';
      updateSessionStatus(this.db, pending.sessionId, newStatus);
      // Publish status change
      if (this.pubnubAdapter) {
        await this.pubnubAdapter.publishEvent({
          type: 'session_status_changed',
          agentId: this.agentId,
          sessionId: pending.sessionId,
          sessionStatus: newStatus,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (message.ui_action === 'DELETE_SESSION' || message.type === 'session_deleted') {
      await this.handleDeleteSession(message.sessionId, message.sessionName);
    } else if (message.ui_action === 'UPDATE_MILO_AGENT') {
      await this.handleSelfUpdate(message.force);
    } else if (message.type === 'ui_action' && (message as unknown as Record<string, unknown>).action === 'check_milo_agent_updates') {
      this.logger.info('Manual update check requested');
      await this.handleCheckForUpdates(message as unknown as Record<string, unknown>);
    } else if (message.type === 'ui_action' && (message as unknown as Record<string, unknown>).action === 'update_milo_agent') {
      this.logger.info('Update requested via ui_action');
      await this.handleSelfUpdate((message as unknown as Record<string, unknown>).force as boolean | undefined);
    } else if (message.type === 'ui_action') {
      await this.handleUiAction(message as unknown as PubNubSkillCommand);
    } else {
      this.logger.verbose(`Unhandled control message type: ${message.type}`);
    }
  }

  /**
   * Handle a UI action from the browser (skill install/update/delete).
   */
  private async handleUiAction(command: PubNubSkillCommand): Promise<void> {
    const { action, skill, requestId } = command;
    this.logger.info(`UI action: ${action} skill=${skill.slug} v${skill.version}`);

    let result: { success: boolean; error?: string };

    switch (action) {
      case 'skill_install':
        result = await this.skillInstaller.installSkill(skill.slug, skill.version, skill.type, skill.filename);
        break;
      case 'skill_update':
        result = await this.skillInstaller.updateSkill(skill.slug, skill.version, skill.type, skill.filename);
        break;
      case 'skill_delete':
        result = await this.skillInstaller.deleteSkill(skill.slug);
        break;
      default:
        this.logger.verbose(`Unhandled ui_action: ${action}`);
        return;
    }

    // Publish result back to browser via PubNub
    if (this.pubnubAdapter) {
      await this.pubnubAdapter.publishEvent({
        type: 'ui_action_result',
        agentId: this.agentId,
        action,
        requestId,
        skillSlug: skill.slug,
        skillVersion: skill.version,
        skillSuccess: result.success,
        skillError: result.error ?? null,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Handle self-update: spawn a detached daemon to update + restart,
   * then shut down so the daemon can take over.
   */
  private async handleSelfUpdate(force?: boolean): Promise<void> {
    this.logger.info(`Self-update requested (force=${force ?? false})`);

    // Check for busy sessions
    const activeSessions = this.actorManager.listActive();
    const busySessions = activeSessions.filter(
      (a) => a.status === 'OPEN_RUNNING'
    );

    if (busySessions.length > 0 && !force) {
      const sessionList = busySessions
        .map((a) => `- ${a.sessionName} (${a.sessionId})`)
        .join('\n');
      const warning = `Cannot update: ${busySessions.length} session(s) are currently running:\n${sessionList}\n\nSend the update command with force=true to update anyway.`;
      this.logger.warn(warning);
      this.broadcastEvent(warning);
      return;
    }

    const packageRoot = getPackageRoot();
    const method = detectInstallMethod(packageRoot);

    // Quick version check — skip if already up to date
    try {
      const latest = await getLatestVersion(method);
      if (latest !== 'unknown' && latest === this.currentVersion) {
        const msg = 'Agent is already up to date.';
        this.logger.info(msg);
        this.broadcastEvent(msg);
        return;
      }
    } catch {
      // If version check fails, proceed with update anyway
      this.logger.verbose('Version check failed, proceeding with update');
    }

    this.logger.info(`Shutting down for update (${method}, root: ${packageRoot})`);
    this.broadcastEvent('Shutting down for update...');

    spawnUpdateDaemon({
      agentPid: process.pid,
      packageRoot,
      method,
      startCommand: process.argv,
      workspaceDir: this.config.workspace.baseDir,
    });

    await this.stop();
    process.exit(0);
  }

  /**
   * Check for available updates and report status.
   */
  private async checkForUpdates(): Promise<void> {
    try {
      const latest = await getLatestVersion(this.installMethod);
      if (latest === 'unknown') {
        this.logger.verbose('Update check: could not determine latest version');
        return;
      }

      const previousNeedsUpdate = this.needsUpdate;
      this.latestVersion = latest;
      this.needsUpdate = this.currentVersion !== latest;

      this.logger.info(`Update check: current=${this.currentVersion}, latest=${latest}, needsUpdate=${this.needsUpdate}`);

      // Notify once when update becomes available
      if (this.needsUpdate && !previousNeedsUpdate) {
        const msg = `A newer version is available (current: ${this.currentVersion}, latest: ${this.latestVersion})`;
        this.logger.info(msg);
        this.broadcastEvent(msg);
      }

      // Report to web app API
      try {
        await this.restAdapter.sendUpdateStatus({
          version: this.currentVersion,
          latestVersion: this.latestVersion,
          needsUpdate: this.needsUpdate,
        });
        this.logger.verbose('Update status reported to web app');
      } catch (err) {
        this.logger.verbose('Failed to report update status:', err);
      }
    } catch (err) {
      this.logger.verbose('Update check failed:', err);
    }
  }

  /**
   * Handle a manual "check for updates" request from the web app.
   * Runs the update check and publishes the result back via PubNub.
   */
  private async handleCheckForUpdates(raw: Record<string, unknown>): Promise<void> {
    const requestId = raw.requestId as string | undefined;

    try {
      await this.checkForUpdates();

      if (this.pubnubAdapter) {
        await this.pubnubAdapter.publishEvent({
          type: 'ui_action_result',
          agentId: this.agentId,
          action: 'check_milo_agent_updates',
          requestId: requestId ?? '',
          currentVersion: this.currentVersion,
          latestVersion: this.latestVersion,
          needsUpdate: this.needsUpdate,
          success: true,
          error: null,
          timestamp: new Date().toISOString(),
        } as unknown as import('../messaging/pubnub-types.js').PubNubEventMessage);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Update check failed:', errorMsg);

      if (this.pubnubAdapter) {
        await this.pubnubAdapter.publishEvent({
          type: 'ui_action_result',
          agentId: this.agentId,
          action: 'check_milo_agent_updates',
          requestId: requestId ?? '',
          success: false,
          error: errorMsg,
          timestamp: new Date().toISOString(),
        } as unknown as import('../messaging/pubnub-types.js').PubNubEventMessage);
      }
    }
  }

  /**
   * Handle session deletion: stop worker, update DB, remove session file.
   */
  private async handleDeleteSession(sessionId: string, sessionName?: string): Promise<void> {
    this.logger.info(`Deleting session ${sessionId} (name=${sessionName})`);

    // 0. Clean up any pending forms for this session
    this.cleanupPendingForms(sessionId);

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
      invalidateCuratedCache(); // Force fresh fetch on explicit /models
      const { text, structured } = await this.getAvailableModels(true);
      this.publishModelsList(message.sessionId, structured, text);
      enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: text }, message.sessionId);
      this.syncModelsToServer();
      return;
    }

    // STATUS_REQUEST doesn't need a worker — handle inline
    if (workItemType === 'STATUS_REQUEST') {
      const statusText = await this.buildStatusReport(message.sessionId);
      this.publishEvent(message.sessionId, statusText);
      enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: statusText }, message.sessionId);
      return;
    }

    // Determine project path — restore confirmed project if available
    let projectPath = join(this.config.workspace.baseDir, this.config.workspace.projectsDir);
    const confirmedProject = getConfirmedProject(this.db, message.sessionId);
    if (confirmedProject) {
      const restored = join(projectPath, confirmedProject);
      if (existsSync(restored)) {
        projectPath = restored;
      }
    }

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
        const actor = this.actorManager.get(sessionId);
        const name = actor?.sessionName ?? sessionId;
        const cancelContent = event.taskId
          ? `Task cancelled in session "${name}".`
          : `No active task to cancel in session "${name}".`;
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
          this.cleanupPendingForms(sessionId);
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

      case 'WORKER_FILE_SEND': {
        const fileContent = `Sent file: ${event.filename}`;
        const fileData = {
          filename: event.filename,
          content: event.content,
          encoding: event.encoding,
          mimeType: event.mimeType,
          sizeBytes: event.sizeBytes,
        };

        // 1. Publish to PubNub for instant display (uses fileContents)
        if (this.pubnubAdapter?.isConnected) {
          this.pubnubAdapter.publishEvent({
            type: 'file_send',
            agentId: this.agentId,
            sessionId,
            content: fileContent,
            fileContents: fileData,
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            this.logger.warn('PubNub file_send publish failed:', err);
          });
        }

        // 2. Enqueue REST persistence (uses fileData)
        enqueueOutbox(this.db, 'send_message', {
          sessionId,
          content: fileContent,
          fileData,
        }, sessionId);
        break;
      }

      case 'WORKER_STREAM_TEXT':
        // Real-time text streaming — publish to user via PubNub (if enabled)
        if (this.config.streaming) {
          this.publishEvent(sessionId, event.delta);
        }
        break;

      case 'WORKER_TOOL_START':
        if (this.pubnubAdapter?.isConnected) {
          this.pubnubAdapter.publishEvent({
            type: 'tool_use',
            agentId: this.agentId,
            sessionId,
            toolName: event.toolName,
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            this.logger.warn('PubNub tool_use publish failed:', err);
          });
        }
        break;

      case 'WORKER_TOOL_END':
        // Only publish tool end if it failed
        if (!event.success) {
          this.publishEvent(sessionId, `Tool ${event.toolName} failed: ${event.summary ?? 'unknown error'}`);
        }
        break;

      case 'WORKER_PROJECT_SET': {
        const actor = this.actorManager.get(sessionId);
        if (actor) {
          actor.projectPath = event.projectPath;
        }
        updateConfirmedProject(this.db, sessionId, event.projectName);
        const verb = event.isNew ? 'Created and set' : 'Set';
        this.logger.info(`${verb} project "${event.projectName}" for session ${sessionId}`);
        break;
      }

      case 'WORKER_QUESTION':
        updateSessionStatus(this.db, sessionId, 'OPEN_WAITING_USER');
        this.publishEvent(sessionId, event.question);
        insertSessionMessage(this.db, sessionId, 'agent', event.question);
        enqueueOutbox(this.db, 'send_message', { sessionId, content: event.question }, sessionId);
        break;

      case 'WORKER_FORM_REQUEST': {
        const { formDefinition } = event;
        // Track the pending form
        this.pendingForms.set(formDefinition.formId, {
          formId: formDefinition.formId,
          sessionId,
          taskId: event.taskId,
        });
        // Update session status
        updateSessionStatus(this.db, sessionId, 'OPEN_INPUT_REQUIRED');
        // Publish form_request event to browser via PubNub
        if (this.pubnubAdapter) {
          this.pubnubAdapter.publishEvent({
            type: 'form_request',
            agentId: this.agentId,
            sessionId,
            formDefinition,
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            this.logger.warn('PubNub form_request publish failed:', err);
          });
          // Also publish session status change
          this.pubnubAdapter.publishEvent({
            type: 'session_status_changed',
            agentId: this.agentId,
            sessionId,
            sessionStatus: 'OPEN_INPUT_REQUIRED',
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            this.logger.warn('PubNub session_status_changed publish failed:', err);
          });
        }
        // Persist form as a message via outbox (for page refresh survival)
        const formContent = JSON.stringify(formDefinition);
        insertSessionMessage(this.db, sessionId, 'agent', formContent);
        enqueueOutbox(this.db, 'send_message', { sessionId, content: formContent, formData: formDefinition }, sessionId);
        break;
      }
    }
  }

  // --- Models ---

  /**
   * Get available models as both formatted text and structured data.
   * Fetches the curated allow-list from the server, filters pi-ai models,
   * and detects local Ollama/LM Studio models.
   */
  private async getAvailableModels(forceRefresh = false): Promise<{
    text: string;
    structured: {
      defaultModel?: string;
      providers: Array<{ provider: string; models: Array<{ id: string; name: string }> }>;
      localModels?: Array<{ provider: string; models: string[] }>;
    };
  }> {
    registerBuiltInApiProviders();
    const allProviders = getProviders();

    // Fetch curated allow-list (cached unless forceRefresh)
    const allowList = await getCuratedAllowList(this.restAdapter, forceRefresh);
    const hasAllowList = allowList.size > 0;

    const lines: string[] = ['Available Models:'];

    const defaultModel = this.config.ai.agent.model || this.config.ai.utility.model;
    if (defaultModel) {
      lines.push(`\nDefault model: ${defaultModel}`);
    }

    lines.push('\nCloud Models:');

    const structuredProviders: Array<{ provider: string; models: Array<{ id: string; name: string }> }> = [];

    for (const provider of allProviders) {
      const envKey = getEnvApiKey(provider);
      if (!envKey) continue;

      // If allow-list is available, skip providers not in it
      if (hasAllowList && !allowList.has(provider)) continue;

      try {
        const models = getModels(provider);
        if (models.length === 0) continue;

        // Filter models against allow-list if available
        const filtered = hasAllowList
          ? models.filter((m) => allowList.get(provider)!.has(m.id))
          : models;
        if (filtered.length === 0) continue;

        lines.push(`\n${provider}:`);
        const providerModels: Array<{ id: string; name: string }> = [];
        for (const model of filtered) {
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

    // Detect local models (Ollama, LM Studio)
    const localModels = await detectLocalModels(this.config);
    let structuredLocal: Array<{ provider: string; models: string[] }> | undefined;

    if (localModels.length > 0) {
      // Group by provider
      const grouped = new Map<string, string[]>();
      for (const lm of localModels) {
        if (!grouped.has(lm.provider)) {
          grouped.set(lm.provider, []);
        }
        grouped.get(lm.provider)!.push(lm.name);
      }

      lines.push('\nLocal Models:');
      structuredLocal = [];
      for (const [provider, models] of grouped) {
        lines.push(`\n${provider}:`);
        for (const name of models) {
          lines.push(`  - ${name}`);
        }
        structuredLocal.push({ provider, models });
      }
    }

    return {
      text: lines.join('\n'),
      structured: {
        defaultModel: defaultModel || undefined,
        providers: structuredProviders,
        localModels: structuredLocal,
      },
    };
  }

  /**
   * Sync available models to the web app database so the UI can display them after page refresh.
   * Fire-and-forget — failures are logged but don't block the caller.
   */
  private syncModelsToServer(): void {
    this.getAvailableModels().then(({ structured }) => {
      const models = structured.providers.flatMap((p) =>
        p.models.map((m) => ({ provider: p.provider, modelId: m.id, displayName: m.name }))
      );

      this.restAdapter.syncModels(models).then(() => {
        this.logger.verbose(`Synced ${models.length} models to server`);
      }).catch((err) => {
        this.logger.warn('Failed to sync models to server:', err);
      });
    }).catch((err) => {
      this.logger.warn('Failed to get models for sync:', err);
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
   * Broadcast an event to all connected clients (no specific session).
   */
  private broadcastEvent(content: string): void {
    if (this.pubnubAdapter?.isConnected) {
      this.pubnubAdapter.publishAgentStatus(content).catch((err) => {
        this.logger.warn('PubNub broadcast failed:', err);
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
            await this.restAdapter.sendMessage(payload.content, payload.sessionId, payload.formData, payload.fileData);
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
      const apiUrl = this.config.messaging.webapp.apiUrl;
      this.logger.error(`Heartbeat failed (server: ${apiUrl}):`, err);
      if (!this.isDefaultServerUrl(apiUrl)) {
        this.logger.error(
          'You are using a custom server URL. If you intended to connect to the official MiloBot server, run `milo init` and set the server URL to https://www.milobot.dev'
        );
      }
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

  // --- Helpers ---

  /**
   * Remove all pendingForms entries for a given session.
   * Called when a session is deleted or its worker dies.
   */
  private cleanupPendingForms(sessionId: string): void {
    for (const [formId, entry] of this.pendingForms) {
      if (entry.sessionId === sessionId) {
        this.pendingForms.delete(formId);
        this.logger.verbose(`Cleaned up pending form ${formId} for session ${sessionId}`);
      }
    }
  }

  private isDefaultServerUrl(apiUrl: string): boolean {
    return /^https?:\/\/(www\.)?milobot\.dev(\/|$)/.test(apiUrl);
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

  /**
   * Format a millisecond duration as a human-readable string (e.g. "2h 15m 3s").
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (parts.length === 0 || secs > 0) parts.push(`${secs}s`);
    return parts.join(' ');
  }

  /**
   * Get available tools with name, label, and description.
   */
  private getAvailableTools(): { name: string; label: string; description: string }[] {
    const dummyCtx: ToolContext = {
      projectPath: join(this.config.workspace.baseDir, this.config.workspace.projectsDir),
      workspaceDir: this.config.workspace.baseDir,
      sessionId: '_status',
      sessionName: '_status',
      currentTaskId: () => null,
      preferAPIKeyClaude: this.config.claudeCode.preferAPIKey,
      sendNotification: () => {},
      askUser: async () => '',
    };
    try {
      return loadTools('full', dummyCtx).map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Build a Markdown-formatted status report.
   */
  private async buildStatusReport(requestingSessionId: string): Promise<string> {
    const lines: string[] = [];

    // --- Header ---
    const uptime = this.startedAt
      ? this.formatUptime(Date.now() - this.startedAt.getTime())
      : 'unknown';
    const pubStatus = this.pubnubAdapter?.isConnected ? 'connected' : 'disconnected';

    lines.push(`### ${this.config.agentName} — Agent Status`);
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push(`| **Uptime** | \`${uptime}\` |`);
    lines.push(`| **Default Model** | \`${this.config.ai.agent.model}\` |`);
    lines.push(`| **Utility Model** | \`${this.config.ai.utility.model}\` |`);
    lines.push(`| **PubNub** | \`${pubStatus}\` |`);
    lines.push(`| **Streaming** | \`${this.config.streaming ? 'on' : 'off'}\` |`);
    lines.push(`| **Version** | \`${this.currentVersion}\` (${this.installMethod}) |`);
    if (this.needsUpdate) {
      lines.push(`| **Latest** | \`${this.latestVersion}\` — **update available** |`);
    }

    // --- Models ---
    const { structured } = await this.getAvailableModels();
    const modelCount = structured.providers.reduce((sum, p) => sum + p.models.length, 0);
    const localCount = structured.localModels?.reduce((sum, p) => sum + p.models.length, 0) ?? 0;
    lines.push('');
    lines.push(`#### Models — ${modelCount} cloud${localCount > 0 ? `, ${localCount} local` : ''} across ${structured.providers.length} provider${structured.providers.length !== 1 ? 's' : ''}`);
    if (structured.providers.length === 0) {
      lines.push('*No API keys configured.*');
    } else {
      for (const provider of structured.providers) {
        const names = provider.models.map((m) => `\`${m.name}\``).join(' · ');
        lines.push(`**${provider.provider}:** ${names}`);
      }
    }
    if (structured.localModels) {
      for (const local of structured.localModels) {
        const names = local.models.map((m) => `\`${m}\``).join(' · ');
        lines.push(`**${local.provider}:** ${names}`);
      }
    }

    // --- Tools ---
    const tools = this.getAvailableTools();
    lines.push('');
    lines.push(`#### Tools — ${tools.length} registered`);
    if (tools.length === 0) {
      lines.push('*(unable to enumerate)*');
    } else {
      const coreNames = new Set([
        'read_file', 'write_file', 'bash', 'list_files', 'grep',
        'git_status', 'git_diff', 'git_commit', 'git_log',
      ]);
      const agentNames = new Set(['claude_code', 'gemini_cli', 'codex_cli']);

      const core = tools.filter((t) => coreNames.has(t.name));
      const agents = tools.filter((t) => agentNames.has(t.name));
      const utility = tools.filter((t) => !coreNames.has(t.name) && !agentNames.has(t.name));

      if (core.length > 0) {
        lines.push(`**Core:** ${core.map((t) => `\`${t.name}\``).join(' · ')}`);
      }
      if (agents.length > 0) {
        lines.push('');
        lines.push('**Agents:**');
        for (const t of agents) {
          let desc = `\`${t.name}\` — ${t.label}`;
          if (t.name === 'claude_code') {
            desc += '. Uses your Anthropic API key (configured during `milo init`). Tokens consumed by Claude Code are billed to your API account at the rate of the model you select.';
          } else if (t.name === 'codex_cli') {
            desc += '. Requires OPENAI_API_KEY (configured during `milo init`) or `codex login`. Tokens are billed to your OpenAI account.';
          }
          lines.push(`- ${desc}`);
        }
      }
      if (utility.length > 0) {
        lines.push('');
        lines.push(`**Utility:** ${utility.map((t) => `\`${t.name}\``).join(' · ')}`);
      }
    }

    // --- Skills ---
    const skillsDir = join(this.config.workspace.baseDir, this.config.workspace.skillsDir);
    const skills = discoverSkills(skillsDir);
    lines.push('');
    lines.push(`#### Skills — ${skills.length} loaded`);
    if (skills.length > 0) {
      for (const skill of skills) {
        lines.push(`- **${skill.name}** — ${skill.description}`);
      }
    } else {
      lines.push('*None*');
    }

    // --- Active sessions ---
    const activeSessions = this.actorManager.listActive();
    lines.push('');
    lines.push(`#### Sessions — ${activeSessions.length} active`);
    if (activeSessions.length === 0) {
      lines.push('*No active sessions*');
    } else {
      lines.push('| Session | Status | Worker | Task | Queue |');
      lines.push('|---|---|---|---|---|');
      for (const actor of activeSessions) {
        const name = actor.sessionId === requestingSessionId
          ? `**${actor.sessionName}** *(this)*`
          : actor.sessionName;
        const status = `\`${actor.status}\``;
        const worker = actor.worker
          ? `\`${actor.worker.state}\` (pid ${actor.worker.pid})`
          : '—';
        const task = actor.currentTask ? 'running' : '—';
        const queued = String(actor.queueHigh.length + actor.queueNormal.length);
        lines.push(`| ${name} | ${status} | ${worker} | ${task} | ${queued} |`);
      }
    }

    return lines.join('\n');
  }

  getStatus() {
    return {
      running: this.isRunning,
      startedAt: this.startedAt?.toISOString() ?? null,
      activeSessions: this.actorManager?.listActive().length ?? 0,
    };
  }
}
