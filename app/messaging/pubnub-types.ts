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
