/**
 * Core type definitions shared across apps
 */

// ============================================================================
// User & Auth Types
// ============================================================================

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Subscription Types
// ============================================================================

export type SubscriptionTier = 'free' | 'standard' | 'pro';

export interface Subscription {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  maxAgents: number;
  pollIntervalMs: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TierLimits {
  maxAgents: number;
  pollIntervalMs: number;
  maxConcurrentSessions: number;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface Agent {
  id: string;
  userId: string;
  name: string;
  apiKeyPrefix: string;
  isOnline: boolean;
  lastHeartbeatAt?: Date;
  claudeCodeAlias: string;
  maxConcurrentSessions: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentWithApiKey extends Agent {
  apiKey: string; // Only returned on creation
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionType = 'chat' | 'bot';

export type SessionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface Session {
  id: string;
  agentId: string;
  userId: string;
  name: string;
  type: SessionType;
  status: SessionStatus;
  completionMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageSender = 'user' | 'agent';

export interface Message {
  id: string;
  agentId: string;
  userId: string;
  sessionId: string;
  sender: MessageSender;
  content: string;
  ackedAt?: Date;
  createdAt: Date;
}

// ============================================================================
// Session File Types (Local Agent)
// ============================================================================

export type TaskStatus = 'pending' | 'completed' | 'failed';

export interface SessionTask {
  description: string;
  status: TaskStatus;
  completedAt?: Date;
  error?: string;
}

export type QuestionStatus = 'pending' | 'answered';

export interface SessionQuestion {
  question: string;
  status: QuestionStatus;
  answer?: string;
  answeredAt?: Date;
}

export interface SessionFile {
  name: string;
  createdAt: Date;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  retryCount: number;
  claudeCodeSessionId?: string;
  lastUserNotification?: Date;
  tasks: SessionTask[];
  enhancedPrompt?: string;
  autoAnswerRules: string[];
  questions: SessionQuestion[];
  messages: Array<{
    timestamp: Date;
    direction: 'TO_USER' | 'FROM_USER';
    content: string;
  }>;
  errors: Array<{
    timestamp: Date;
    message: string;
    retryNumber?: number;
  }>;
}

// ============================================================================
// Config Types (Local Agent)
// ============================================================================

export interface AgentConfig {
  agentName: string;
  agentId?: string;
  aliases: Record<string, string>;
  workspace: {
    baseDir: string;
    projectsDir: string;
    sessionsDir: string;
    templatesDir: string;
    toolsDir: string;
    personasDir: string;
  };
  claudeCode: {
    maxConcurrentSessions: number;
    startupMaxRetries: number;
    startupRetryIntervalSeconds: number;
  };
  scheduler: {
    heartbeatIntervalMinutes: number;
    userNotificationThrottleMinutes: number;
  };
  tasks: {
    maxRetries: number;
  };
  tools: {
    safeTools: string[];
    requireConfirmation: string[];
  };
  messaging: {
    activeAdapter: 'webapp' | 'telegram';
    webapp: {
      apiUrl: string;
      pollIntervalMs: number;
    };
    telegram: {
      enabled: boolean;
      botToken?: string;
      chatId?: string;
    };
  };
  onboardingComplete: boolean;
}

// ============================================================================
// Intent Types
// ============================================================================

export type IntentType =
  | 'create_project'
  | 'open_session'
  | 'send_message'
  | 'answer_question'
  | 'question'
  | 'greeting'
  | 'list_sessions'
  | 'cancel_session'
  | 'set_rule'
  | 'unknown';

export interface ParsedIntent {
  type: IntentType;
  projectName?: string;
  sessionName?: string;
  taskDescription?: string;
  answer?: string;
  rule?: string;
  confidence: number;
  raw: string;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolMeta {
  name: string;
  description: string;
  safe: boolean;
  args?: Record<string, {
    type: 'string' | 'number' | 'boolean';
    description: string;
    required?: boolean;
    default?: unknown;
  }>;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}
