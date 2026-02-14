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

  private agentId: string = '';
  private cmdChannel: string = '';
  private evtChannel: string = '';
  private token: string = '';
  private tokenExpiresAt: Date = new Date(0);
  private refreshTimer: NodeJS.Timeout | null = null;

  public isConnected: boolean = false;
  /** When true, sendMessage skips REST persistence and only publishes via PubNub */
  public pubsubOnly: boolean = false;

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
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
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
    this.agentId = tokenData.userId;
    this.cmdChannel = tokenData.channels.cmd;
    this.evtChannel = tokenData.channels.evt;

    this.logger.info(`PubNub channels: cmd=${this.cmdChannel}, evt=${this.evtChannel}`);

    // Create PubNub instance
    this.pubnub = new PubNub({
      subscribeKey: tokenData.subscribeKey,
      publishKey: tokenData.publishKey,
      userId: tokenData.userId,
      restore: true, // Auto-reconnect and replay missed messages
    });

    // Set PAM v3 token (must use setToken, not authKey which is PAM v2)
    this.pubnub.setToken(this.token);

    // Wait for the subscription to actually be confirmed or denied
    const pubnub = this.pubnub;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('PubNub subscription timed out after 10s'));
      }, 10000);

      pubnub.addListener({
        message: (event) => {
          this.logger.verbose(`PubNub message event on channel: ${event.channel}`);
          this.logger.debug('PubNub message payload:', event.message);
          if (event.channel === this.cmdChannel) {
            this.handleIncomingMessage(event.message as unknown as PubNubCommandMessage);
          } else {
            this.logger.verbose(`Ignoring message on non-cmd channel: ${event.channel} (expected: ${this.cmdChannel})`);
          }
        },
        status: (event) => {
          this.logger.verbose(`PubNub status: ${event.category}`);
          if (event.category === 'PNConnectedCategory') {
            this.isConnected = true;
            this.logger.info('PubNub subscription confirmed');
            clearTimeout(timeout);
            resolve();
          } else if (event.category === 'PNAccessDeniedCategory') {
            this.isConnected = false;
            this.logger.warn('PubNub access denied — token lacks subscribe permissions');
            clearTimeout(timeout);
            reject(new Error('PubNub access denied — token lacks subscribe permissions'));
          } else if (event.category === 'PNDisconnectedCategory') {
            this.isConnected = false;
            this.logger.warn('PubNub disconnected');
          } else if (event.category === 'PNReconnectedCategory') {
            this.isConnected = true;
            this.logger.info('PubNub reconnected');
          }
        },
      });

      // Subscribe to command channel (no presence — avoids extra permission requirements)
      pubnub.subscribe({
        channels: [this.cmdChannel],
      });
    });

    // Schedule token refresh
    this.scheduleRefresh();

    this.logger.info('PubNub connection established');
  }

  /**
   * Handle an incoming PubNub message on the cmd channel
   */
  private handleIncomingMessage(msg: PubNubCommandMessage): void {
    this.logger.verbose(`PubNub cmd message: type=${msg.type}, messageId=${msg.messageId}`);
    if (msg.type !== 'user_message') {
      this.logger.verbose(`Ignoring non-user_message type: ${msg.type}`);
      return;
    }

    const pending: PendingMessage = {
      id: msg.messageId,
      sessionId: msg.sessionId,
      sessionName: msg.sessionName ?? null,
      sessionType: msg.sessionType || 'bot',
      content: msg.content,
      uiAction: msg.uiAction,
      createdAt: msg.timestamp,
    };

    this.logger.info(`Real-time message received: ${msg.messageId}`);
    this.logger.verbose(`Message content: "${msg.content.slice(0, 100)}"`);

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

  // --- MessagingAdapter Interface Implementation ---

  /**
   * Send a message to the user
   * Dual-write: REST API for DB persistence + PubNub for instant delivery
   */
  async sendMessage(content: string, sessionId: string): Promise<void> {
    this.logger.verbose(`Sending message (${content.length} chars, session: ${sessionId}, pubsubOnly: ${this.pubsubOnly})`);

    // 1. Persist to DB via REST (unless responding to a real-time message)
    if (!this.pubsubOnly) {
      this.logger.verbose('  Persisting message via REST...');
      await this.request('POST', '/messages/send', {
        sessionId,
        content,
      });
      this.logger.verbose('  REST persist OK');
    } else {
      this.logger.verbose('  Skipping REST persist (pubsubOnly mode)');
    }

    // 2. Publish to PubNub for instant delivery to browser
    if (this.pubnub && this.isConnected) {
      this.logger.verbose(`  Publishing to PubNub evt channel: ${this.evtChannel}`);
      try {
        const message: PubNubEventMessage = {
          type: 'agent_message',
          agentId: this.agentId,
          sessionId,
          content,
          timestamp: new Date().toISOString(),
        };

        const publishResult = await this.pubnub.publish({
          channel: this.evtChannel,
          message: message as unknown as PubNub.Payload,
        });
        this.logger.verbose(`  PubNub publish OK (timetoken: ${publishResult.timetoken})`);
      } catch (pubErr) {
        // PubNub failure is non-fatal - message is in DB
        this.logger.warn('PubNub publish failed (message saved to DB):', pubErr);
      }
    } else {
      this.logger.verbose(`  Skipping PubNub publish (pubnub: ${!!this.pubnub}, connected: ${this.isConnected})`);
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
  async sendHeartbeat(activeSessions: string[] = []): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>('POST', '/agent/heartbeat', { activeSessions });
  }

  /**
   * Publish a session update event to the browser
   */
  async publishSessionUpdate(sessionId: string, status: string, name: string, sessionName?: string): Promise<void> {
    if (!this.pubnub || !this.isConnected) return;

    try {
      const message: PubNubEventMessage = {
        type: 'session_update',
        agentId: this.agentId,
        sessionId,
        sessionStatus: status,
        sessionName: sessionName || name,
        content: name,
        timestamp: new Date().toISOString(),
      };

      await this.pubnub.publish({
        channel: this.evtChannel,
        message: message as unknown as PubNub.Payload,
      });
    } catch (err) {
      this.logger.warn('PubNub session update publish failed:', err);
    }
  }

  /**
   * Publish an agent status event (e.g. "Bot is online") via PubNub only
   */
  async publishAgentStatus(content: string): Promise<void> {
    if (!this.pubnub || !this.isConnected) {
      this.logger.warn(`Cannot publish agent status "${content}" (pubnub: ${!!this.pubnub}, connected: ${this.isConnected})`);
      return;
    }

    this.logger.verbose(`Publishing agent status "${content}" to ${this.evtChannel}...`);
    try {
      const message: PubNubEventMessage = {
        type: 'agent_status',
        agentId: this.agentId,
        content,
        timestamp: new Date().toISOString(),
      };

      const result = await this.pubnub.publish({
        channel: this.evtChannel,
        message: message as unknown as PubNub.Payload,
      });
      this.logger.info(`Published agent status: "${content}" (timetoken: ${result.timetoken})`);
    } catch (err) {
      this.logger.warn('PubNub agent status publish failed:', err);
    }
  }

  /**
   * Send a message with context size information
   */
  async sendMessageWithContext(
    content: string,
    sessionId: string,
    contextSize?: { usedTokens: number; maxTokens: number }
  ): Promise<void> {
    // Persist to DB
    if (!this.pubsubOnly) {
      await this.request('POST', '/messages/send', { sessionId, content });
    }

    // Publish to PubNub with context size
    if (this.pubnub && this.isConnected) {
      try {
        const message: PubNubEventMessage = {
          type: 'agent_message',
          agentId: this.agentId,
          sessionId,
          content,
          contextSize,
          timestamp: new Date().toISOString(),
        };

        await this.pubnub.publish({
          channel: this.evtChannel,
          message: message as unknown as PubNub.Payload,
        });
      } catch (pubErr) {
        this.logger.warn('PubNub publish failed:', pubErr);
      }
    }
  }

  // --- Private Helpers ---

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
