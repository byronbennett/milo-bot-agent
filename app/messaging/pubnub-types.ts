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
  sessionName?: string;
  content: string;
  uiAction?: string;
  persona?: string;
  model?: string;
  timestamp: string;
}

/**
 * Orchestrator → Browser (evt channel)
 *
 * Discriminated union by `type`. The browser uses `type` to route
 * each event to the correct UI handler.
 */
export type PubNubEventType =
  | 'agent_message'
  | 'session_update'
  | 'agent_status'
  | 'message_received'
  | 'session_status_changed'
  | 'subagent_started'
  | 'subagent_stopped'
  | 'subagent_output'
  | 'task_cancel_requested'
  | 'task_cancelled'
  | 'error';

export interface PubNubEventMessage {
  type: PubNubEventType;
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
  /** The message_id this receipt acknowledges (for message_received) */
  receivedMessageId?: string;
  /** Whether the message was queued for processing */
  queued?: boolean;
  /** Error details for error events */
  errorMessage?: string;
  /** Worker PID for subagent lifecycle events */
  workerPid?: number;
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
