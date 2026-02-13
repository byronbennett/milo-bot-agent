import type { HeartbeatResponse, PendingMessage } from '../shared';

/**
 * Abstract messaging adapter interface
 * All messaging adapters (web app, telegram, etc.) implement this
 */
export interface MessagingAdapter {
  /**
   * Send a message to the user
   */
  sendMessage(content: string, sessionId: string): Promise<void>;

  /**
   * Get pending messages from the user
   */
  getPendingMessages(): Promise<PendingMessage[]>;

  /**
   * Acknowledge that messages have been processed
   */
  acknowledgeMessages(messageIds: string[]): Promise<void>;

  /**
   * Send heartbeat to keep agent online
   */
  sendHeartbeat(activeSessions?: string[]): Promise<HeartbeatResponse>;
}
