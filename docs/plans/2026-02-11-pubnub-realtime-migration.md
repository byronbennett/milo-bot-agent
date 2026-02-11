# PubNub Real-Time Migration Plan: milo-bot-agent

**Date**: 2026-02-11
**Status**: Draft
**Scope**: Replace cron-based polling with PubNub real-time messaging

---

## 1. Overview

Migrate the milo-bot-agent TypeScript CLI from a cron-based polling architecture (heartbeat every 3 minutes, polling `GET /api/messages/pending`) to PubNub real-time messaging. The agent subscribes to its command channel and receives messages instantly. It publishes responses on its event channel.

**Key principle**: The REST API endpoints are kept for startup catch-up, DB acknowledgment, and fallback. PubNub handles real-time delivery. The `MessagingAdapter` interface is preserved, so the rest of the agent code does not change.

### Current Architecture (Polling)

```
HeartbeatScheduler (node-cron, every 3 min)
  ├── POST /agent/heartbeat         -> Server confirms agent online
  ├── GET /messages/pending          -> Returns unacked messages
  ├── processMessage() for each      -> Intent parse + execute
  ├── POST /messages/ack             -> Mark as processed
  └── Check active sessions
```

### Target Architecture (PubNub + REST Fallback)

```
PubNub Subscription (cmd channel)
  └── onMessage callback             -> Instant message processing

HeartbeatScheduler (reduced to every 5 min)
  ├── POST /agent/heartbeat          -> DB state only
  ├── Check for missed messages      -> Only if PubNub is disconnected
  └── Check active sessions

Startup:
  ├── Acquire PubNub token from server
  ├── Subscribe to cmd channel
  └── GET /messages/pending           -> Catch up on missed messages
```

---

## 2. Security Model

The agent never holds the PubNub secret key. The security flow:

1. Agent authenticates to the web app with its existing `MILO_API_KEY` (via `x-api-key` header)
2. Web app validates the API key, then uses its secret key to mint a PubNub token
3. Token grants: `read` on the agent's cmd channel, `write` on the agent's evt channel
4. Agent connects to PubNub using only pub/sub keys + token
5. Token has 12-hour TTL, refreshed at 80%

---

## 3. New Dependency

```bash
pnpm add pubnub
```

- `pubnub` ^8.0.0 - PubNub SDK for Node.js

---

## 4. Configuration Changes

### 4.1 Config Schema

File: `app/config/schema.ts`

Add a PubNub configuration section:

```typescript
export const pubnubConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export const agentConfigSchema = z.object({
  agentName: z.string().min(1).max(100),
  agentId: z.string().optional(),
  aliases: z.record(z.string()).default({
    CC: 'Claude Code',
    claude: 'Claude Code',
  }),
  workspace: workspaceConfigSchema,
  claudeCode: claudeCodeConfigSchema.default({}),
  scheduler: schedulerConfigSchema.default({}),
  tasks: tasksConfigSchema.default({}),
  tools: toolsConfigSchema.default({}),
  ai: aiConfigSchema.default({}),
  messaging: messagingConfigSchema.default({}),
  pubnub: pubnubConfigSchema.default({}),       // NEW
  onboardingComplete: z.boolean().default(false),
});
```

### 4.2 Config Defaults

File: `app/config/defaults.ts`

```typescript
// Add to defaultConfig:
pubnub: {
  enabled: true,
},
```

PubNub keys are NOT stored in config. They are received from the server during token acquisition.

---

## 5. New Files

### 5.1 `app/messaging/pubnub-types.ts` - Type Definitions

```typescript
/**
 * PubNub message payload types
 * Must match the web project's definitions exactly
 */

/** User -> Agent (received on cmd channel) */
export interface PubNubCommandMessage {
  type: 'user_message';
  messageId: string;
  agentId: string;
  sessionId: string | null;
  content: string;
  timestamp: string;
}

/** Agent -> User (published on evt channel) */
export interface PubNubEventMessage {
  type: 'agent_message' | 'session_update' | 'agent_status';
  messageId?: string;
  agentId: string;
  sessionId?: string | null;
  content?: string;
  sessionStatus?: string;
  timestamp: string;
}

/** Response from POST /api/pubnub/token/agent */
export interface PubNubTokenResponse {
  token: string;
  ttl: number;         // seconds
  expiresAt: string;   // ISO 8601
  userId: string;      // PubNub UUID for this agent
  channels: {
    cmd: string;       // Full cmd channel name
    evt: string;       // Full evt channel name
  };
  subscribeKey: string;
  publishKey: string;
}
```

### 5.2 `app/messaging/pubnub-adapter.ts` - PubNub Messaging Adapter

This is the core new file. It implements the existing `MessagingAdapter` interface using PubNub for real-time delivery, while keeping REST calls for DB persistence and catch-up.

```typescript
import PubNub from 'pubnub';
import type { MessagingAdapter } from './adapter';
import type { HeartbeatResponse, PendingMessage } from '../shared';
import type { PubNubCommandMessage, PubNubEventMessage, PubNubTokenResponse } from './pubnub-types';
import { Logger } from '../utils/logger';

export interface PubNubAdapterOptions {
  apiUrl: string;
  apiKey: string;
  onMessage: (message: PendingMessage) => Promise<void>;
  logger?: Logger;
}

export class PubNubAdapter implements MessagingAdapter {
  private pubnub: PubNub | null = null;
  private apiUrl: string;
  private apiKey: string;
  private onMessage: (message: PendingMessage) => Promise<void>;
  private logger: Logger;

  private cmdChannel: string = '';
  private evtChannel: string = '';
  private token: string = '';
  private tokenExpiresAt: Date = new Date(0);
  private refreshTimer: NodeJS.Timeout | null = null;

  public isConnected: boolean = false;

  constructor(options: PubNubAdapterOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.onMessage = options.onMessage;
    this.logger = options.logger || new Logger({ prefix: '[pubnub]' });
  }

  /**
   * Acquire PubNub token from the web app server
   */
  private async acquireToken(): Promise<PubNubTokenResponse> {
    const url = `${this.apiUrl}/pubnub/token/agent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Token acquisition failed (${response.status}): ${errorBody.error || response.statusText}`);
    }

    return response.json() as Promise<PubNubTokenResponse>;
  }

  /**
   * Initialize PubNub connection: acquire token, subscribe to cmd channel
   */
  async connect(): Promise<void> {
    this.logger.info('Acquiring PubNub token...');
    const tokenData = await this.acquireToken();

    this.token = tokenData.token;
    this.tokenExpiresAt = new Date(tokenData.expiresAt);
    this.cmdChannel = tokenData.channels.cmd;
    this.evtChannel = tokenData.channels.evt;

    this.logger.info(`PubNub channels: cmd=${this.cmdChannel}, evt=${this.evtChannel}`);

    // Create PubNub instance
    this.pubnub = new PubNub({
      subscribeKey: tokenData.subscribeKey,
      publishKey: tokenData.publishKey,
      userId: tokenData.userId,
      authKey: this.token,
      restore: true, // Auto-reconnect and replay missed messages
    });

    // Add message listener
    this.pubnub.addListener({
      message: (event) => {
        if (event.channel === this.cmdChannel) {
          this.handleIncomingMessage(event.message as PubNubCommandMessage);
        }
      },
      status: (event) => {
        if (event.category === 'PNConnectedCategory') {
          this.isConnected = true;
          this.logger.info('PubNub connected');
        } else if (event.category === 'PNDisconnectedCategory') {
          this.isConnected = false;
          this.logger.warn('PubNub disconnected');
        } else if (event.category === 'PNReconnectedCategory') {
          this.isConnected = true;
          this.logger.info('PubNub reconnected');
        }
      },
    });

    // Subscribe to command channel with Presence
    this.pubnub.subscribe({
      channels: [this.cmdChannel],
      withPresence: true,
    });

    // Set presence state with agent info
    this.pubnub.setState({
      channels: [this.cmdChannel],
      state: {
        startedAt: new Date().toISOString(),
      },
    });

    // Schedule token refresh
    this.scheduleRefresh();

    this.isConnected = true;
    this.logger.info('PubNub connection established');
  }

  /**
   * Handle an incoming PubNub message on the cmd channel
   */
  private handleIncomingMessage(msg: PubNubCommandMessage): void {
    if (msg.type !== 'user_message') return;

    const pending: PendingMessage = {
      id: msg.messageId,
      sessionId: msg.sessionId,
      sessionName: null, // Not available from PubNub payload
      content: msg.content,
      createdAt: msg.timestamp,
    };

    this.logger.debug(`Real-time message received: ${msg.messageId}`);

    // Process asynchronously - don't block the listener
    this.onMessage(pending).catch((err) => {
      this.logger.error('Error processing real-time message:', err);
    });
  }

  /**
   * Graceful disconnect
   */
  async disconnect(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.pubnub) {
      // unsubscribeAll triggers a "leave" Presence event
      this.pubnub.unsubscribeAll();
      // Brief wait for the leave event to propagate
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.pubnub = null;
    }

    this.isConnected = false;
    this.logger.info('PubNub disconnected');
  }

  /**
   * Schedule token refresh at 80% of TTL
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const now = Date.now();
    const expiresAt = this.tokenExpiresAt.getTime();
    const ttlMs = expiresAt - now;
    const refreshIn = Math.max(ttlMs * 0.8, 60000); // Minimum 1 minute

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshToken();
      } catch (error) {
        this.logger.error('Token refresh failed:', error);
        // Retry in 1 minute
        this.refreshTimer = setTimeout(() => {
          this.refreshToken().catch((err) =>
            this.logger.error('Token refresh retry failed:', err)
          );
        }, 60000);
      }
    }, refreshIn);

    this.logger.debug(`Token refresh scheduled in ${Math.round(refreshIn / 1000)}s`);
  }

  /**
   * Refresh the PubNub token
   */
  private async refreshToken(): Promise<void> {
    this.logger.info('Refreshing PubNub token...');

    const tokenData = await this.acquireToken();
    this.token = tokenData.token;
    this.tokenExpiresAt = new Date(tokenData.expiresAt);

    if (this.pubnub) {
      this.pubnub.setToken(this.token);
    }

    this.scheduleRefresh();
    this.logger.info('PubNub token refreshed');
  }

  // ─── MessagingAdapter Interface Implementation ───

  /**
   * Send a message to the user
   * Dual-write: REST API for DB persistence + PubNub for instant delivery
   */
  async sendMessage(content: string, sessionId?: string | null): Promise<void> {
    // 1. Persist to DB via REST (source of truth)
    await this.request('POST', '/messages/send', {
      sessionId: sessionId || null,
      content,
    });

    // 2. Publish to PubNub for instant delivery to browser
    if (this.pubnub && this.isConnected) {
      try {
        const message: PubNubEventMessage = {
          type: 'agent_message',
          agentId: '', // Server knows from channel context
          sessionId: sessionId || null,
          content,
          timestamp: new Date().toISOString(),
        };

        await this.pubnub.publish({
          channel: this.evtChannel,
          message,
        });
      } catch (pubErr) {
        // PubNub failure is non-fatal - message is in DB
        this.logger.warn('PubNub publish failed (message saved to DB):', pubErr);
      }
    }
  }

  /**
   * Get pending messages from the user
   * Still uses REST API - called on startup for catch-up
   */
  async getPendingMessages(): Promise<PendingMessage[]> {
    const response = await this.request<{ messages: PendingMessage[] }>(
      'GET',
      '/messages/pending'
    );
    return response.messages;
  }

  /**
   * Acknowledge that messages have been processed
   * Still uses REST API - DB needs to track ack status
   */
  async acknowledgeMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    await this.request('POST', '/messages/ack', {
      messageIds,
    });
  }

  /**
   * Send heartbeat to keep agent online in DB
   * Still uses REST API - supplements PubNub Presence
   */
  async sendHeartbeat(): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>('POST', '/agent/heartbeat');
  }

  /**
   * Publish a session update event to the browser
   */
  async publishSessionUpdate(sessionId: string, status: string, name: string): Promise<void> {
    if (!this.pubnub || !this.isConnected) return;

    try {
      const message: PubNubEventMessage = {
        type: 'session_update',
        agentId: '',
        sessionId,
        sessionStatus: status,
        content: name,
        timestamp: new Date().toISOString(),
      };

      await this.pubnub.publish({
        channel: this.evtChannel,
        message,
      });
    } catch (err) {
      this.logger.warn('PubNub session update publish failed:', err);
    }
  }

  // ─── Private Helpers ───

  /**
   * Make an authenticated REST API request (same as WebAppAdapter)
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      throw new Error(`API error (${response.status}): ${errorBody.error || response.statusText}`);
    }

    return response.json() as Promise<T>;
  }
}
```

---

## 6. Modified Files

### 6.1 `app/messaging/index.ts` - Export PubNubAdapter

```typescript
export type { MessagingAdapter } from './adapter';
export { WebAppAdapter, type WebAppAdapterOptions } from './webapp-adapter';
export { PubNubAdapter, type PubNubAdapterOptions } from './pubnub-adapter';
```

### 6.2 `app/agent.ts` - Major Modifications

The `MiloAgent` class needs changes to support PubNub with REST fallback.

#### Constructor Changes

```typescript
import { WebAppAdapter, PubNubAdapter, type MessagingAdapter } from './messaging';

export class MiloAgent {
  private config: AgentConfig;
  private logger: Logger;
  private messagingAdapter: MessagingAdapter;
  private restAdapter: WebAppAdapter;           // NEW: always available for REST operations
  private pubnubAdapter: PubNubAdapter | null;  // NEW: null when PubNub disabled
  private sessionManager: SessionManager;
  private scheduler: HeartbeatScheduler;
  private isRunning: boolean = false;
  private shuttingDown: boolean = false;

  constructor(options: AgentOptions) {
    this.config = options.config;

    if (options.apiKey) {
      process.env.MILO_API_KEY = options.apiKey;
    }

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

    this.setupShutdownHandlers();
  }
```

#### New Method: `handleRealtimeMessage()`

```typescript
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
```

#### New Method: `catchUpMessages()`

```typescript
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
```

#### Modified `start()` Method

```typescript
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
```

#### Modified `stop()` Method

```typescript
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
```

#### Modified `handleHeartbeat()` Method

```typescript
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
```

### 6.3 `app/commands/start.ts` - Add `--no-pubnub` Flag

```typescript
import { Command } from 'commander';
import { MiloAgent } from '../agent';
import { loadConfig } from '../config';
import { Logger } from '../utils/logger';

const logger = new Logger({ prefix: '[start]' });

export const startCommand = new Command('start')
  .description('Start the MiloBot agent daemon')
  .option('-c, --config <path>', 'Path to config file')
  .option('-d, --debug', 'Enable debug logging')
  .option('--foreground', "Run in foreground (don't daemonize)")
  .option('--no-pubnub', 'Disable PubNub real-time messaging (use polling)')
  .action(async (options) => {
    logger.info('Starting MiloBot agent...');

    const config = await loadConfig(options.config);

    if (!process.env.MILO_API_KEY) {
      logger.error('MILO_API_KEY environment variable is not set.');
      logger.error('Run `milo init` to set up your workspace and API key.');
      process.exit(1);
    }

    // Override PubNub config from CLI flag
    if (options.pubnub === false) {
      config.pubnub.enabled = false;
      logger.info('PubNub disabled via --no-pubnub flag, using polling');
    }

    try {
      const agent = new MiloAgent({
        config,
        debug: options.debug,
      });

      await agent.start();

      logger.info('Agent is running. Press Ctrl+C to stop.');

      process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      setInterval(() => {}, 1000);
    } catch (error) {
      logger.error('Failed to start agent:', error);
      process.exit(1);
    }
  });
```

---

## 7. Presence for Heartbeat

When the agent subscribes to its cmd channel with `withPresence: true`, PubNub automatically tracks the agent's presence. The browser (subscribed to the same channel family) receives join/leave/timeout events.

| Event | What Happens |
|-------|-------------|
| Agent subscribes | PubNub fires `join` event -> browser marks agent online |
| Agent calls `unsubscribeAll()` (graceful stop) | PubNub fires `leave` event -> browser marks agent offline immediately |
| Agent crashes / network drops | PubNub fires `timeout` event after 300s -> browser marks agent offline |

The agent can optionally set rich presence state on connect:

```typescript
pubnub.setState({
  channels: [this.cmdChannel],
  state: {
    agentName: config.agentName,
    startedAt: new Date().toISOString(),
  },
});
```

The HTTP heartbeat endpoint is kept at 5-minute intervals (reduced from 3 minutes) to maintain the DB `isOnline` and `lastHeartbeatAt` fields as a reliable secondary source.

---

## 8. Graceful Shutdown

The `disconnect()` method in `PubNubAdapter`:

1. Clears the token refresh timer
2. Calls `pubnub.unsubscribeAll()` which triggers a `leave` Presence event
3. Waits 500ms for the event to propagate
4. Nulls the PubNub instance

The existing shutdown handlers in `agent.ts` (SIGTERM, SIGINT) already call `this.stop()`, which now calls `pubnubAdapter.disconnect()`. No changes needed to the shutdown flow.

---

## 9. Offline Catch-Up Strategy

```
Agent starts:
  1. Acquire PubNub token from server via POST /api/pubnub/token/agent
  2. Subscribe to cmd channel
  3. Call GET /api/messages/pending (REST) for all unacked messages
  4. Process each pending message
  5. Acknowledge them via POST /api/messages/ack
  6. From this point, new messages arrive via PubNub subscription
  7. If PubNub disconnects temporarily:
     a. PubNub SDK's `restore: true` option replays missed messages on reconnect
     b. Messages are still persisted in DB by the web app
     c. Periodic heartbeat (every 5 min) checks for pending messages as safety net
```

---

## 10. Fallback Strategy

If PubNub is unavailable (token endpoint returns 404, connection fails, network issues):

```
PubNub connected?
  YES -> Messages arrive via subscription, process immediately
       -> HTTP heartbeat every 5 minutes (DB state only)
  NO  -> HTTP heartbeat every 3 minutes (original behavior)
       -> Poll GET /api/messages/pending each cycle
       -> Process and acknowledge as before
```

This is achieved by:
1. `this.pubnubAdapter?.isConnected` check in `handleHeartbeat()`
2. Falling back to `this.restAdapter` as `this.messagingAdapter` if PubNub connection fails on startup
3. The `--no-pubnub` CLI flag for explicit disabling

---

## 11. Cross-Project API Contract

The agent depends on this endpoint existing on the web app:

### `POST /api/pubnub/token/agent`

**Request**:
- Header: `x-api-key: <MILO_API_KEY>`
- Body: none required

**Response** (200):
```json
{
  "token": "pn-token-...",
  "ttl": 43200,
  "expiresAt": "2026-02-12T00:00:00Z",
  "userId": "agent-clxyz123abc",
  "channels": {
    "cmd": "milo.clxyz123abc.cmd.a1b2c3d4...",
    "evt": "milo.clxyz123abc.evt.a1b2c3d4..."
  },
  "subscribeKey": "sub-c-...",
  "publishKey": "pub-c-..."
}
```

**Response** (401): `{ "error": "Unauthorized" }` - invalid API key
**Response** (404): endpoint doesn't exist yet (agent falls back to polling)

---

## 12. Implementation Phases

### Phase 1: Types and Config (non-breaking)
- [ ] Create `app/messaging/pubnub-types.ts`
- [ ] Add `pubnub` section to `app/config/schema.ts`
- [ ] Add defaults to `app/config/defaults.ts`
- [ ] Add `pubnub` dependency to `package.json`

### Phase 2: PubNub Adapter (non-breaking, new file)
- [ ] Create `app/messaging/pubnub-adapter.ts` implementing `MessagingAdapter`
- [ ] Implement: `connect()`, `disconnect()`, token acquisition, token refresh
- [ ] Implement: `sendMessage()` with dual-write (REST + PubNub publish)
- [ ] Implement: PubNub message listener with `onMessage` callback
- [ ] Keep `getPendingMessages()`, `acknowledgeMessages()`, `sendHeartbeat()` as REST calls
- [ ] Update `app/messaging/index.ts` to export `PubNubAdapter`

### Phase 3: Agent Integration (behind `--no-pubnub` flag)
- [ ] Modify `app/agent.ts` constructor: conditional PubNub/REST adapter + REST fallback
- [ ] Add `handleRealtimeMessage()` method
- [ ] Add `catchUpMessages()` method
- [ ] Modify `start()`: connect PubNub, catch up, reduce heartbeat
- [ ] Modify `stop()`: disconnect PubNub gracefully
- [ ] Modify `handleHeartbeat()`: skip polling when PubNub is connected
- [ ] Add `--no-pubnub` flag to `app/commands/start.ts`

### Phase 4: Testing
- [ ] Test PubNub connection and subscription
- [ ] Test real-time message delivery (user -> agent)
- [ ] Test agent response delivery (agent -> user via PubNub + REST)
- [ ] Test offline catch-up on startup
- [ ] Test token refresh (mock 12-hour TTL)
- [ ] Test graceful shutdown (leave Presence event)
- [ ] Test fallback to polling when PubNub unavailable
- [ ] Test `--no-pubnub` flag

---

## 13. Files Summary

### New Files

| File | Purpose |
|------|---------|
| `app/messaging/pubnub-adapter.ts` | PubNub implementation of MessagingAdapter |
| `app/messaging/pubnub-types.ts` | PubNub message payload types + TokenResponse |

### Modified Files

| File | Change |
|------|--------|
| `app/agent.ts` | Conditional PubNub/REST adapter, real-time handler, catch-up, modified start/stop/heartbeat |
| `app/messaging/index.ts` | Export PubNubAdapter |
| `app/config/schema.ts` | Add pubnub config section |
| `app/config/defaults.ts` | Add pubnub defaults |
| `app/commands/start.ts` | Add `--no-pubnub` CLI flag |
| `package.json` | Add pubnub dependency |

---

## 14. Deployment Order

The web app must be deployed first (token grant endpoint must exist before the agent can request tokens).

1. Deploy web app with Phases 1-3 (token endpoints + server-side publishing)
2. Deploy agent with Phases 1-3 (PubNub adapter + agent integration)
3. If agent connects to an older web app without the token endpoint, it gets a 404 and falls back to polling automatically
