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
import { Logger, logger } from './utils/logger';
import { parseIntentWithAI, describeIntent, isConfident } from './intent';
import { isAIAvailable, getAIClient, getAIModel } from './utils/ai-client';
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
  verbose?: boolean;
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
    // debug > verbose > info (debug shows everything, verbose shows steps + info)
    const logLevel = options.debug ? 'debug' : options.verbose ? 'verbose' : 'info';
    this.logger = new Logger({
      level: logLevel,
      prefix: `[${this.config.agentName}]`,
    });

    // Propagate log level to the default singleton used by parser, ai-client, etc.
    logger.setLevel(logLevel);

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
      this.logger.verbose('Discovering user tools...');
      const toolsDir = join(this.config.workspace.baseDir, this.config.workspace.toolsDir);
      const toolCount = await discoverTools(toolsDir, 'user');
      this.logger.info(`Discovered ${toolCount} user tools`);
      this.logger.verbose(`Tools directory: ${toolsDir}`);

      // Verify API key and connection
      this.logger.verbose('Verifying API key with server heartbeat...');
      try {
        const heartbeatResult = await this.restAdapter.sendHeartbeat();
        this.logger.info(`Connected as agent: ${heartbeatResult.agentId}`);
        this.logger.verbose(`Server URL: ${this.config.messaging.webapp.apiUrl}`);
      } catch (heartbeatError) {
        this.logger.warn('Could not reach server, will retry:', heartbeatError);
      }

      // Connect PubNub if enabled
      if (this.pubnubAdapter) {
        this.logger.verbose('Connecting PubNub for real-time messaging...');
        try {
          await this.pubnubAdapter.connect();
          this.logger.info('PubNub connected - real-time messaging enabled');

          // With PubNub, reduce heartbeat to every 5 minutes (DB state only)
          this.scheduler.setInterval(5);
          this.logger.verbose('Heartbeat interval reduced to 5 min (PubNub handles messages)');
        } catch (error) {
          this.logger.warn('PubNub connection failed, falling back to polling:', error);
          // Fall back to REST adapter
          this.messagingAdapter = this.restAdapter;
          this.pubnubAdapter = null;
        }
      } else {
        this.logger.verbose('PubNub disabled, using REST polling');
        this.logger.verbose(`Poll interval: ${this.config.scheduler.heartbeatIntervalMinutes} min`);
      }

      // Catch up on missed messages (always needed on startup)
      this.logger.verbose('Catching up on missed messages...');
      await this.catchUpMessages();

      // Start scheduler
      this.logger.verbose('Starting heartbeat scheduler...');
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
    this.logger.verbose('Heartbeat cycle starting...');
    try {
      // 1. Always send HTTP heartbeat for DB state (include active session names)
      this.logger.verbose('Sending HTTP heartbeat to server...');
      const activeSessions = await this.sessionManager.listActiveSessions();
      const activeSessionNames = activeSessions.map((s) => s.name);
      await this.restAdapter.sendHeartbeat(activeSessionNames);
      this.logger.verbose('Heartbeat acknowledged by server');

      // 2. Only poll for pending messages if PubNub is NOT connected
      //    When PubNub is active, messages arrive in real-time via onMessage callback
      if (!this.pubnubAdapter?.isConnected) {
        this.logger.verbose('Polling for pending messages (PubNub not connected)...');
        const pendingMessages = await this.restAdapter.getPendingMessages();

        if (pendingMessages.length > 0) {
          this.logger.verbose(`Found ${pendingMessages.length} pending message(s)`);

          for (const message of pendingMessages) {
            await this.processMessage(message);
          }

          await this.restAdapter.acknowledgeMessages(
            pendingMessages.map((m) => m.id)
          );
          this.logger.verbose(`Acknowledged ${pendingMessages.length} message(s)`);
        } else {
          this.logger.verbose('No pending messages');
        }
      } else {
        this.logger.verbose('Skipping message poll (PubNub is connected)');
      }

      // 3. Check active sessions (reuse list from heartbeat above)
      this.logger.verbose(`Checking ${activeSessions.length} active session(s)`);

      for (const session of activeSessions) {
        await this.processSession(session);
      }
      this.logger.verbose('Heartbeat cycle complete');
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
    this.logger.verbose(`Message via PubNub (session: ${message.sessionId ?? 'none'}, content: "${message.content.slice(0, 80)}")`);

    try {
      // Send immediate acknowledgement via PubNub only (no DB persist for transient ack)
      if (this.pubnubAdapter) {
        this.pubnubAdapter.pubsubOnly = true;
        await this.messagingAdapter.sendMessage('Message received. Processing...', message.sessionId);
        this.pubnubAdapter.pubsubOnly = false;
        this.logger.verbose('Sent immediate PubNub acknowledgement');
      }

      // Process the message (dual-write: PubNub + REST)
      await this.processMessage(message);

      this.logger.verbose('Acknowledging real-time message via REST...');
      await this.restAdapter.acknowledgeMessages([message.id]);
      this.logger.verbose('Real-time message processing complete');
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
      this.logger.verbose('Fetching pending messages from server...');
      const pending = await this.restAdapter.getPendingMessages();
      if (pending.length > 0) {
        this.logger.info(`Catching up on ${pending.length} missed messages`);
        for (let i = 0; i < pending.length; i++) {
          this.logger.verbose(`Processing catch-up message ${i + 1}/${pending.length}: "${pending[i].content.slice(0, 80)}"`);
          await this.processMessage(pending[i]);
        }
        await this.restAdapter.acknowledgeMessages(pending.map((m) => m.id));
        this.logger.info('Catch-up complete');
      } else {
        this.logger.verbose('No missed messages to catch up on');
      }
    } catch (error) {
      this.logger.warn('Message catch-up failed:', error);
    }
  }

  /**
   * Process an incoming message
   */
  private async processMessage(message: PendingMessage): Promise<void> {
    const startTime = Date.now();
    this.logger.debug(`Processing message: ${message.id}`);
    this.logger.info(`Received: ${message.content}`);

    try {
      // Route by session type: chat sessions get direct AI response
      if (message.sessionType === 'chat') {
        await this.handleChatMessage(message);
        const elapsed = Date.now() - startTime;
        this.logger.verbose(`Chat message processing complete (${elapsed}ms)`);
        return;
      }

      // Bot session: use intent parser (existing flow)
      // Step 1: Parse intent
      this.logger.verbose('Step 1: Parsing intent...');
      this.logger.verbose(`  AI available: ${isAIAvailable()}, ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);
      const intent = await parseIntentWithAI(message, this.config);
      this.logger.verbose(`  Intent: ${intent.type} (confidence: ${intent.confidence})`);
      this.logger.verbose(`  ${describeIntent(intent)}`);

      // Step 2: Route by intent type
      this.logger.verbose(`Step 2: Routing to handler "${intent.type}"...`);
      switch (intent.type) {
        case 'open_session':
          await this.handleOpenSession(intent, message);
          break;

        case 'send_message':
          await this.handleSendMessage(intent, message);
          break;

        case 'question':
          this.logger.verbose('  Answering question');
          await this.messagingAdapter.sendMessage(
            intent.answer ?? 'I\'m not sure how to answer that.',
            message.sessionId
          );
          break;

        case 'greeting':
          this.logger.verbose('  Responding to greeting');
          await this.messagingAdapter.sendMessage(
            intent.answer ?? 'Hello! How can I help you today?',
            message.sessionId
          );
          break;

        case 'unknown':
        default:
          this.logger.verbose('  Intent unknown, sending clarification to user');
          if (isConfident(intent, 0.3)) {
            await this.messagingAdapter.sendMessage(
              `I'm not sure what you want me to do. Could you clarify?\n\nI understood: "${message.content}"`,
              message.sessionId
            );
          } else {
            await this.messagingAdapter.sendMessage(
              `I didn't understand that. Try something like:\n` +
              `• "fix the login bug in my-project"\n` +
              `• "add dark mode to the frontend"\n` +
              `• "refactor the auth module"`,
              message.sessionId
            );
          }
          break;
      }

      const elapsed = Date.now() - startTime;
      this.logger.verbose(`Message processing complete (${elapsed}ms)`);
    } catch (error) {
      this.logger.error('Failed to process message:', error);
      await this.messagingAdapter.sendMessage(
        `Sorry, I encountered an error processing your message: ${error}`,
        message.sessionId
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
    this.logger.verbose('  Checking session limits...');
    const activeSessions = await this.sessionManager.listActiveSessions();
    const maxSessions = this.config.claudeCode.maxConcurrentSessions;
    this.logger.verbose(`  Active sessions: ${activeSessions.length}/${maxSessions}`);

    if (activeSessions.length >= maxSessions) {
      this.logger.verbose('  Session limit reached, notifying user');
      await this.messagingAdapter.sendMessage(
        `Cannot start new session. You have ${activeSessions.length}/${maxSessions} active sessions.\n` +
        `Active sessions: ${activeSessions.map((s) => s.name).join(', ')}`,
        message.sessionId
      );
      return;
    }

    // Enhance the prompt
    this.logger.verbose('  Enhancing prompt...');
    const enhanceResult = await enhancePrompt(taskDescription, {
      context: {
        projectName: intent.projectName,
      },
    });
    this.logger.verbose(`  Enhancement strategy: ${enhanceResult.usedAI ? 'AI' : enhanceResult.templateType ? `template (${enhanceResult.templateType})` : 'minimal'}`);
    this.logger.verbose(`  Enhanced prompt: "${enhanceResult.prompt.slice(0, 100)}..." (${enhanceResult.prompt.length} chars)`);

    // Create session file
    this.logger.verbose(`  Creating session file: ${sessionName}`);
    const session = await this.sessionManager.createSession(sessionName, enhanceResult.prompt);
    this.logger.verbose(`  Session file created`);

    // Notify user
    this.logger.verbose('  Notifying user of session start...');
    await this.messagingAdapter.sendMessage(
      `Starting session: ${sessionName}\n` +
      (intent.projectName ? `Project: ${intent.projectName}\n` : '') +
      `Task: ${taskDescription}`,
      message.sessionId
    );

    // Create and run task list
    const projectPath = intent.projectName
      ? join(this.config.workspace.baseDir, this.config.workspace.projectsDir, intent.projectName)
      : this.config.workspace.baseDir;

    this.logger.verbose(`  Project path: ${projectPath}`);
    const tasks = createStandardTaskList(sessionName, enhanceResult.prompt, projectPath);
    this.logger.verbose(`  Created ${tasks.length} task(s): ${tasks.map(t => t.type).join(' → ')}`);
    this.logger.verbose('  Executing tasks...');

    const taskStart = Date.now();
    const result = await runTasks(tasks, {
      sessionId: session.name,
      sessionName: session.name,
      projectPath,
      workspaceDir: this.config.workspace.baseDir,
      previousResults: new Map(),
    });
    const taskElapsed = Date.now() - taskStart;

    // Update session status based on result
    if (result.success) {
      await this.sessionManager.updateSessionStatus(sessionName, 'COMPLETED');
      this.logger.verbose(`  Session completed: ${result.completedTasks} tasks in ${(taskElapsed / 1000).toFixed(1)}s`);
      await this.messagingAdapter.sendMessage(
        `Session completed: ${sessionName}\n` +
        `Completed: ${result.completedTasks} tasks`,
        message.sessionId
      );
    } else {
      await this.sessionManager.updateSessionStatus(sessionName, 'FAILED');
      this.logger.verbose(`  Session failed after ${(taskElapsed / 1000).toFixed(1)}s: ${result.errors.map(e => e.error).join(', ')}`);
      await this.messagingAdapter.sendMessage(
        `Session failed: ${sessionName}\n` +
        `Errors: ${result.errors.map((e) => e.error).join(', ')}`,
        message.sessionId
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
    this.logger.verbose(`  Looking up target session: "${sessionName ?? 'none'}"`);

    if (!sessionName) {
      this.logger.verbose('  No session name found, notifying user');
      await this.messagingAdapter.sendMessage(
        'No active session to send message to. Start a new session first.',
        message.sessionId
      );
      return;
    }

    // Get the session
    const session = await this.sessionManager.getSession(sessionName);
    if (!session) {
      this.logger.verbose(`  Session "${sessionName}" not found in session manager`);
      await this.messagingAdapter.sendMessage(
        `Session "${sessionName}" not found.`,
        message.sessionId
      );
      return;
    }

    this.logger.verbose(`  Session found (status: ${session.status}), forwarding message`);

    // Forward the message to the session
    this.logger.info(`Message for session ${sessionName}: ${message.content}`);

    await this.messagingAdapter.sendMessage(
      `Message received for session: ${sessionName}`,
      message.sessionId
    );
  }

  /**
   * Handle a message in a chat session (direct AI response, no Claude Code)
   */
  private async handleChatMessage(message: PendingMessage): Promise<void> {
    this.logger.info(`Chat session message: ${message.sessionId}`);

    // Fetch chat history for context
    const history = await this.fetchSessionHistory(message.sessionId);

    // Build conversation for the AI
    const conversationMessages = history.map((m) => ({
      role: m.sender === 'user' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    }));

    // Add the current message
    conversationMessages.push({ role: 'user', content: message.content });

    try {
      const ai = getAIClient();
      const model = getAIModel();

      const response = await ai.messages.create({
        model,
        max_tokens: 4096,
        system:
          'You are MiloBot, a helpful coding assistant. The user is chatting with you for quick tasks like reading files, counting things, or answering questions. Be concise and helpful.',
        messages: conversationMessages,
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      const responseText =
        textBlock?.type === 'text' ? textBlock.text : 'No response generated.';

      // Calculate context size
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const usedTokens = inputTokens + outputTokens;
      const maxTokens = 200000; // Claude model context limit

      // Send response with context size
      if (this.pubnubAdapter && this.pubnubAdapter.isConnected) {
        await this.pubnubAdapter.sendMessageWithContext(responseText, message.sessionId, {
          usedTokens,
          maxTokens,
        });
      } else {
        await this.messagingAdapter.sendMessage(responseText, message.sessionId);
      }
    } catch (error) {
      this.logger.error('Chat AI response failed:', error);
      await this.messagingAdapter.sendMessage(
        'Sorry, I encountered an error generating a response.',
        message.sessionId
      );
    }
  }

  /**
   * Fetch message history for a session from the web API
   */
  private async fetchSessionHistory(
    sessionId: string
  ): Promise<Array<{ sender: string; content: string }>> {
    try {
      return await this.restAdapter.getSessionHistory(sessionId);
    } catch {
      return [];
    }
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
