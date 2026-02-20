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
  session_name?: string;   // snake_case wire format from web app API
  content: string;
  uiAction?: string;
  ui_action?: string;      // snake_case wire format from web app API
  personaId?: string;
  personaVersionId?: string;
  model?: string;
  timestamp: string;
}

/** Server -> Agent control messages (received on cmd channel) */
export interface PubNubControlMessage {
  type: string;
  ui_action?: string;
  agentId: string;
  sessionId: string;
  sessionName?: string;
  force?: boolean;
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
  | 'models_list'
  | 'subagent_started'
  | 'subagent_stopped'
  | 'subagent_output'
  | 'task_cancel_requested'
  | 'task_cancelled'
  | 'ui_action_result'
  | 'tool_use'
  | 'form_request'
  | 'file_send'
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
  /** Structured model list for models_list events */
  models?: {
    defaultModel?: string;
    providers: Array<{
      provider: string;
      models: Array<{ id: string; name: string }>;
    }>;
    localModels?: Array<{
      provider: string;
      models: string[];
    }>;
  };
  /** Tool name for tool_use events */
  toolName?: string;
  /** Skill action result fields */
  action?: string;
  requestId?: string;
  skillSlug?: string;
  skillVersion?: string;
  skillSuccess?: boolean;
  skillError?: string | null;
  /** Form definition for form_request events */
  formDefinition?: import('../shared/form-types.js').FormDefinition;
  /** File contents for file_send events */
  fileContents?: {
    filename: string;
    content: string;
    encoding: 'utf-8' | 'base64' | 'gzip+base64';
    mimeType: string;
    sizeBytes: number;
  };
  timestamp: string;
}

/** Skill action command from browser (received on cmd channel) */
export interface PubNubSkillCommand {
  type: 'ui_action';
  action: 'skill_install' | 'skill_update' | 'skill_delete';
  skill: {
    slug: string;
    version: string;
    type: 'md' | 'zip';
    filename: string;
  };
  requestId: string;
}

/** Form response from browser (received on cmd channel) */
export interface PubNubFormResponseCommand {
  type: 'form_response';
  messageId: string;
  agentId: string;
  sessionId: string;
  formId: string;
  status: 'submitted' | 'cancelled';
  values?: Record<string, string | number | boolean>;
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
