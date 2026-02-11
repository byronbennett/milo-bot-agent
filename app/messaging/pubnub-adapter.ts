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
          this.handleIncomingMessage(event.message as unknown as PubNubCommandMessage);
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

  // --- MessagingAdapter Interface Implementation ---

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
          message: message as unknown as PubNub.Payload,
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
        message: message as unknown as PubNub.Payload,
      });
    } catch (err) {
      this.logger.warn('PubNub session update publish failed:', err);
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
