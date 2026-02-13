/**
 * PubNub message payload types
 * Must match the web project's definitions exactly
 */

/** User -> Agent (received on cmd channel) */
export interface PubNubCommandMessage {
  type: 'user_message';
  messageId: string;
  agentId: string;
  sessionId: string;
  sessionType: 'chat' | 'bot';
  content: string;
  timestamp: string;
}

/** Agent -> User (published on evt channel) */
export interface PubNubEventMessage {
  type: 'agent_message' | 'session_update' | 'agent_status';
  messageId?: string;
  agentId: string;
  sessionId?: string;
  content?: string;
  sessionStatus?: string;
  sessionName?: string;
  sessionType?: 'chat' | 'bot';
  contextSize?: {
    usedTokens: number;
    maxTokens: number;
  };
  timestamp: string;
}

/** Response from POST /api/pubnub/token/agent */
export interface PubNubTokenResponse {
  token: string;
  ttl: number;
  expiresAt: string;
  userId: string;
  channels: {
    cmd: string;
    evt: string;
  };
  subscribeKey: string;
  publishKey: string;
}
