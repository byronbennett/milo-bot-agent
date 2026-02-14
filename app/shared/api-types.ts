/**
 * API request and response types
 */

import type { Agent, Message, Session, SessionStatus, SessionType, SubscriptionTier } from './types';

// ============================================================================
// Common Response Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// ============================================================================
// Heartbeat API
// ============================================================================

export interface HeartbeatRequest {
  activeSessions: string[];
}

export interface HeartbeatResponse {
  ok: boolean;
  pollIntervalMs: number;
  agentId: string;
  isOnline: boolean;
}

// ============================================================================
// Messages API
// ============================================================================

export interface PendingMessage {
  id: string;
  sessionId: string;
  sessionName: string | null;
  sessionType: SessionType;
  content: string;
  uiAction?: string;
  createdAt: string;
}

export interface GetPendingMessagesResponse {
  messages: PendingMessage[];
}

export interface AckMessagesRequest {
  messageIds: string[];
}

export interface AckMessagesResponse {
  acknowledged: number;
}

export interface SendMessageRequest {
  sessionId: string;
  content: string;
}

export interface SendMessageResponse {
  messageId: string;
}

export interface ListMessagesParams {
  agentId?: string;
  sessionId?: string | null;
  limit?: number;
  before?: string; // cursor for pagination
}

export interface ListMessagesResponse {
  messages: Message[];
  nextCursor?: string;
}

// ============================================================================
// Sessions API
// ============================================================================

export interface CreateSessionRequest {
  name: string;
  type?: SessionType;
}

export interface CreateSessionResponse {
  session: Session;
}

export interface UpdateSessionRequest {
  status?: SessionStatus;
  name?: string;
  completionMessage?: string;
}

export interface UpdateSessionResponse {
  session: Session;
}

export interface ListSessionsParams {
  status?: SessionStatus | 'archived';
  type?: SessionType;
  limit?: number;
}

export interface ListSessionsResponse {
  sessions: Session[];
}

// ============================================================================
// Agents API
// ============================================================================

export interface CreateAgentRequest {
  name: string;
}

export interface CreateAgentResponse {
  agent: Agent;
  apiKey: string; // Only returned on creation, plain text
}

export interface UpdateAgentRequest {
  name?: string;
  claudeCodeAlias?: string;
  maxConcurrentSessions?: number;
}

export interface UpdateAgentResponse {
  agent: Agent;
}

export interface ListAgentsResponse {
  agents: Agent[];
}

export interface RegenerateApiKeyResponse {
  apiKey: string;
  apiKeyPrefix: string;
}

// ============================================================================
// User API
// ============================================================================

export interface GetUserResponse {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
  };
  subscription: {
    tier: SubscriptionTier;
    maxAgents: number;
    pollIntervalMs: number;
  };
  agentCount: number;
}

// ============================================================================
// Auth API
// ============================================================================

export interface LoginRequest {
  email: string;
}

export interface LoginResponse {
  message: string;
}

export interface VerifyOtpRequest {
  email: string;
  code: string;
}

export interface VerifyOtpResponse {
  success: boolean;
}

// ============================================================================
// Onboarding API
// ============================================================================

export interface OnboardingStatusResponse {
  completed: boolean;
  hasAgent: boolean;
  agentConnected: boolean;
}

// ============================================================================
// Error Responses
// ============================================================================

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, string[]>;
}

export const API_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  TIER_LIMIT_EXCEEDED: 'TIER_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
