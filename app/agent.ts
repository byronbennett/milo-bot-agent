/**
 * Main Agent Orchestrator
 *
 * Coordinates all agent components:
 * - Messaging adapter (web app API)
 * - Session manager
 * - Task orchestrator
 * - Claude Code bridge
 * - Heartbeat scheduler
 * - Intent parser
 * - Prompt enhancer
 * - Auto-answer system
 * - Tool registry
 */

import type { PendingMessage } from './shared';
import type { AgentConfig } from './config';
import { WebAppAdapter, PubNubAdapter, type MessagingAdapter } from './messaging';
import { SessionManager } from './session/manager';
import { HeartbeatScheduler } from './scheduler/heartbeat';
import { Logger } from './utils/logger';
import { parseIntentWithAI, describeIntent, isConfident } from './intent';
import { enhancePrompt } from './prompt';
import { runTasks, createStandardTaskList } from './task';
import { shouldAutoAnswer } from './auto-answer';
import { discoverTools } from './tools';
import { openSession, sendPrompt, closeSession, getActiveSessionCount } from './claude-code';
import { join } from 'path';

export interface AgentOptions {
  config: AgentConfig;
  apiKey?: string;
  debug?: boolean;
}

export class MiloAgent {
  private config: AgentConfig;
  private logger: Logger;
  private messagingAdapter: MessagingAdapter;
  private restAdapter: WebAppAdapter;
  private pubnubAdapter: PubNubAdapter | null;
  private sessionManager: SessionManager;
  private scheduler: HeartbeatScheduler;
  private isRunning: boolean = false;
  private shuttingDown: boolean = false;

  constructor(options: AgentOptions) {
    // Use pre-loaded configuration
    this.config = options.config;

    // Override API key if provided
    if (options.apiKey) {
      process.env.MILO_API_KEY = options.apiKey;
    }

    // Initialize logger
    this.logger = new Logger({
      level: options.debug ? 'debug' : 'info',
      prefix: `[${this.config.agentName}]`,
    });

    // Always create a REST adapter for fallback and DB operations
    this.restAdapter = new WebAppAdapter({
      apiUrl: this.config.messaging.webapp.apiUrl,
      apiKey: process.env.MILO_API_KEY || '',
    });

    // Create PubNub adapter if enabled
    if (this.config.pubnub.enabled) {
      this.pubnubAdapter = new PubNubAdapter({
        apiUrl: this.config.messaging.webapp.apiUrl,
        apiKey: process.env.MILO_API_KEY || '',
        onMessage: this.handleRealtimeMessage.bind(this),
        logger: this.logger,
      });
      // PubNubAdapter implements MessagingAdapter, so it can be used as the primary adapter
      this.messagingAdapter = this.pubnubAdapter;
    } else {
      this.pubnubAdapter = null;
      this.messagingAdapter = this.restAdapter;
    }

    this.sessionManager = new SessionManager({
      baseDir: this.config.workspace.baseDir,
      sessionsDir: this.config.workspace.sessionsDir,
    });

    this.scheduler = new HeartbeatScheduler({
      intervalMinutes: this.config.scheduler.heartbeatIntervalMinutes,
      onHeartbeat: this.handleHeartbeat.bind(this),
    });

    // Setup graceful shutdown
    this.setupShutdownHandlers();
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;

      this.logger.info(`Received ${signal}, shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Agent is already running');
      return;
    }

    this.logger.info('Starting MiloBot agent...');

    try {
      // Discover user tools
      const toolsDir = join(this.config.workspace.baseDir, this.config.workspace.toolsDir);
      const toolCount = await discoverTools(toolsDir, 'user');
      this.logger.info(`Discovered ${toolCount} user tools`);

      // Verify API key and connection
      try {
        const heartbeatResult = await this.restAdapter.sendHeartbeat();
        this.logger.info(`Connected as agent: ${heartbeatResult.agentId}`);
      } catch (heartbeatError) {
        this.logger.warn('Could not reach server, will retry:', heartbeatError);
      }

      // Connect PubNub if enabled
      if (this.pubnubAdapter) {
        try {
          await this.pubnubAdapter.connect();
          this.logger.info('PubNub connected - real-time messaging enabled');

          // With PubNub, reduce heartbeat to every 5 minutes (DB state only)
          this.scheduler.setInterval(5);
        } catch (error) {
          this.logger.warn('PubNub connection failed, falling back to polling:', error);
          // Fall back to REST adapter
          this.messagingAdapter = this.restAdapter;
          this.pubnubAdapter = null;
        }
      }

      // Catch up on missed messages (always needed on startup)
      await this.catchUpMessages();

      // Start scheduler
      this.scheduler.start();

      this.isRunning = true;
      this.logger.info('Agent started successfully');
    } catch (error) {
      this.logger.error('Failed to start agent:', error);
      throw error;
    }
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Agent is not running');
      return;
    }

    this.logger.info('Stopping MiloBot agent...');

    // Disconnect PubNub gracefully (triggers leave Presence event)
    if (this.pubnubAdapter) {
      await this.pubnubAdapter.disconnect();
      this.logger.info('PubNub disconnected');
    }

    // Stop scheduler
    this.scheduler.stop();

    this.isRunning = false;
    this.logger.info('Agent stopped');
  }

  /**
   * Handle heartbeat cycle
   */
  private async handleHeartbeat(): Promise<void> {
    try {
      // 1. Always send HTTP heartbeat for DB state
      await this.restAdapter.sendHeartbeat();

      // 2. Only poll for pending messages if PubNub is NOT connected
      //    When PubNub is active, messages arrive in real-time via onMessage callback
      if (!this.pubnubAdapter?.isConnected) {
        const pendingMessages = await this.restAdapter.getPendingMessages();

        if (pendingMessages.length > 0) {
          this.logger.debug(`Received ${pendingMessages.length} pending messages`);

          for (const message of pendingMessages) {
            await this.processMessage(message);
          }

          await this.restAdapter.acknowledgeMessages(
            pendingMessages.map((m) => m.id)
          );
        }
      }

      // 3. Check active sessions (unchanged)
      const activeSessions = await this.sessionManager.listActiveSessions();

      for (const session of activeSessions) {
        await this.processSession(session);
      }
    } catch (error) {
      this.logger.error('Heartbeat failed:', error);
    }
  }

  /**
   * Handle a message received in real-time via PubNub
   * Called by the PubNubAdapter's onMessage callback
   */
  private async handleRealtimeMessage(message: PendingMessage): Promise<void> {
    this.logger.info(`Real-time message received: ${message.id}`);

    try {
      // Process the message (same logic as processMessage)
      await this.processMessage(message);

      // Acknowledge via REST so the DB tracks it
      await this.restAdapter.acknowledgeMessages([message.id]);
    } catch (error) {
      this.logger.error('Failed to process real-time message:', error);
    }
  }

  /**
   * Catch up on messages missed while agent was offline
   * Called on startup, uses REST API
   */
  private async catchUpMessages(): Promise<void> {
    try {
      const pending = await this.restAdapter.getPendingMessages();
      if (pending.length > 0) {
        this.logger.info(`Catching up on ${pending.length} missed messages`);
        for (const message of pending) {
          await this.processMessage(message);
        }
        await this.restAdapter.acknowledgeMessages(pending.map((m) => m.id));
        this.logger.info('Catch-up complete');
      }
    } catch (error) {
      this.logger.warn('Message catch-up failed:', error);
    }
  }

  /**
   * Process an incoming message
   */
  private async processMessage(message: PendingMessage): Promise<void> {
    this.logger.debug(`Processing message: ${message.id}`);
    this.logger.info(`Received: ${message.content}`);

    try {
      // Parse the intent
      const intent = await parseIntentWithAI(message, this.config);
      this.logger.debug(`Parsed intent: ${describeIntent(intent)}`);

      // Handle based on intent type
      switch (intent.type) {
        case 'open_session':
          await this.handleOpenSession(intent, message);
          break;

        case 'send_message':
          await this.handleSendMessage(intent, message);
          break;

        case 'unknown':
        default:
          if (isConfident(intent, 0.3)) {
            // Low confidence but might be a task
            await this.messagingAdapter.sendMessage(
              `I'm not sure what you want me to do. Could you clarify?\n\nI understood: "${message.content}"`
            );
          } else {
            await this.messagingAdapter.sendMessage(
              `I didn't understand that. Try something like:\n` +
              `• "fix the login bug in my-project"\n` +
              `• "add dark mode to the frontend"\n` +
              `• "refactor the auth module"`
            );
          }
          break;
      }
    } catch (error) {
      this.logger.error('Failed to process message:', error);
      await this.messagingAdapter.sendMessage(
        `Sorry, I encountered an error processing your message: ${error}`
      );
    }
  }

  /**
   * Handle open_session intent
   */
  private async handleOpenSession(
    intent: { sessionName?: string; projectName?: string; taskDescription?: string },
    message: PendingMessage
  ): Promise<void> {
    const sessionName = intent.sessionName ?? `session-${Date.now()}`;
    const taskDescription = intent.taskDescription ?? message.content;

    // Check concurrent session limit
    const activeSessions = await this.sessionManager.listActiveSessions();
    const maxSessions = this.config.claudeCode.maxConcurrentSessions;

    if (activeSessions.length >= maxSessions) {
      await this.messagingAdapter.sendMessage(
        `Cannot start new session. You have ${activeSessions.length}/${maxSessions} active sessions.\n` +
        `Active sessions: ${activeSessions.map((s) => s.name).join(', ')}`
      );
      return;
    }

    // Enhance the prompt
    const enhanceResult = await enhancePrompt(taskDescription, {
      context: {
        projectName: intent.projectName,
      },
    });

    this.logger.debug(`Enhanced prompt: ${enhanceResult.prompt.slice(0, 100)}...`);

    // Create session file
    const session = await this.sessionManager.createSession(sessionName, enhanceResult.prompt);

    // Notify user
    await this.messagingAdapter.sendMessage(
      `Starting session: ${sessionName}\n` +
      (intent.projectName ? `Project: ${intent.projectName}\n` : '') +
      `Task: ${taskDescription}`
    );

    // Create and run task list
    const projectPath = intent.projectName
      ? join(this.config.workspace.baseDir, this.config.workspace.projectsDir, intent.projectName)
      : this.config.workspace.baseDir;

    const tasks = createStandardTaskList(sessionName, enhanceResult.prompt, projectPath);

    const result = await runTasks(tasks, {
      sessionId: session.name,
      sessionName: session.name,
      projectPath,
      workspaceDir: this.config.workspace.baseDir,
      previousResults: new Map(),
    });

    // Update session status based on result
    if (result.success) {
      await this.sessionManager.updateSessionStatus(sessionName, 'COMPLETED');
      await this.messagingAdapter.sendMessage(
        `Session completed: ${sessionName}\n` +
        `Completed: ${result.completedTasks} tasks`
      );
    } else {
      await this.sessionManager.updateSessionStatus(sessionName, 'FAILED');
      await this.messagingAdapter.sendMessage(
        `Session failed: ${sessionName}\n` +
        `Errors: ${result.errors.map((e) => e.error).join(', ')}`
      );
    }
  }

  /**
   * Handle send_message intent (to existing session)
   */
  private async handleSendMessage(
    intent: { sessionName?: string; taskDescription?: string },
    message: PendingMessage
  ): Promise<void> {
    const sessionName = intent.sessionName ?? message.sessionName;

    if (!sessionName) {
      await this.messagingAdapter.sendMessage(
        'No active session to send message to. Start a new session first.'
      );
      return;
    }

    // Get the session
    const session = await this.sessionManager.getSession(sessionName);
    if (!session) {
      await this.messagingAdapter.sendMessage(
        `Session "${sessionName}" not found.`
      );
      return;
    }

    // Forward the message to the session
    // This would integrate with Claude Code session if active
    this.logger.info(`Message for session ${sessionName}: ${message.content}`);

    await this.messagingAdapter.sendMessage(
      `Message received for session: ${sessionName}`,
      message.sessionId
    );
  }

  /**
   * Process an active session
   */
  private async processSession(session: { name: string; status: string }): Promise<void> {
    this.logger.debug(`Processing session: ${session.name} (${session.status})`);

    // Check for pending questions in Claude Code sessions
    // This would integrate with the Claude Code bridge
    if (session.status === 'IN_PROGRESS') {
      // Monitor the session for questions or completion
      // For now, just log
      this.logger.debug(`Session ${session.name} is in progress`);
    }
  }

  /**
   * Get agent status
   */
  getStatus(): {
    running: boolean;
    config: AgentConfig;
    activeSessions: number;
    ccSessions: number;
  } {
    return {
      running: this.isRunning,
      config: this.config,
      activeSessions: 0, // Would be populated from sessionManager
      ccSessions: getActiveSessionCount(),
    };
  }

  /**
   * Health check - returns true if agent is healthy
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    checks: Record<string, boolean>;
  }> {
    const checks: Record<string, boolean> = {
      running: this.isRunning,
      configLoaded: !!this.config,
      messagingAdapter: false,
    };

    try {
      // Check messaging adapter connectivity
      await this.messagingAdapter.sendHeartbeat();
      checks.messagingAdapter = true;
    } catch {
      checks.messagingAdapter = false;
    }

    const healthy = Object.values(checks).every((c) => c);

    return { healthy, checks };
  }
}
