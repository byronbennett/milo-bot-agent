import type { MessagingAdapter } from './adapter';
import type { HeartbeatResponse, PendingMessage } from '../shared';

export interface WebAppAdapterOptions {
  apiUrl: string;
  apiKey: string;
}

/**
 * Web app API adapter for messaging
 */
export class WebAppAdapter implements MessagingAdapter {
  private apiUrl: string;
  private apiKey: string;

  constructor(options: WebAppAdapterOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = options.apiKey;
  }

  /**
   * Make an authenticated API request
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

  /**
   * Send a message to the user
   */
  async sendMessage(content: string, sessionId: string): Promise<void> {
    await this.request('POST', '/messages/send', {
      sessionId,
      content,
    });
  }

  /**
   * Get pending messages from the user
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
   */
  async acknowledgeMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    await this.request('POST', '/messages/ack', {
      messageIds,
    });
  }

  /**
   * Send heartbeat to keep agent online
   */
  async sendHeartbeat(activeSessions: string[] = []): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>('POST', '/agent/heartbeat', { activeSessions });
  }

  /**
   * Fetch message history for a session
   */
  async getSessionHistory(
    sessionId: string,
    limit: number = 50
  ): Promise<Array<{ sender: string; content: string }>> {
    const response = await this.request<{
      messages: Array<{ sender: string; content: string }>;
    }>('GET', `/messages/history?sessionId=${sessionId}&limit=${limit}`);
    return response.messages;
  }

  /**
   * Update a session (name, status, etc.)
   */
  async updateSession(
    sessionId: string,
    updates: { name?: string; status?: string; completionMessage?: string }
  ): Promise<void> {
    await this.request('PATCH', `/sessions/${sessionId}`, updates);
  }
}
