/**
 * Shared constants across apps
 */

import type { SubscriptionTier, TierLimits } from './types';

// ============================================================================
// Subscription Tiers
// ============================================================================

export const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    maxAgents: 1,
    pollIntervalMs: 1800000, // 30 minutes
    maxConcurrentSessions: 1,
  },
  standard: {
    maxAgents: 3,
    pollIntervalMs: 60000, // 1 minute
    maxConcurrentSessions: 3,
  },
  pro: {
    maxAgents: 10,
    pollIntervalMs: 5000, // 5 seconds
    maxConcurrentSessions: 5,
  },
};

export const DEFAULT_TIER: SubscriptionTier = 'free';

// ============================================================================
// API Configuration
// ============================================================================

export const API_VERSION = 'v1';

export const API_ENDPOINTS = {
  HEARTBEAT: '/api/agent/heartbeat',
  MESSAGES_PENDING: '/api/messages/pending',
  MESSAGES_ACK: '/api/messages/ack',
  MESSAGES_SEND: '/api/messages/send',
  SESSIONS: '/api/sessions',
  AGENTS: '/api/agents',
} as const;

// ============================================================================
// Agent Defaults
// ============================================================================

export const AGENT_DEFAULTS = {
  claudeCodeAlias: 'CC',
  maxConcurrentSessions: 3,
  heartbeatIntervalMinutes: 3,
  userNotificationThrottleMinutes: 20,
  maxTaskRetries: 3,
  startupMaxRetries: 5,
  startupRetryIntervalSeconds: 30,
} as const;

// ============================================================================
// Session Status
// ============================================================================

export const SESSION_STATUSES = ['active', 'completed', 'failed', 'cancelled'] as const;

// ============================================================================
// Timeouts & Intervals
// ============================================================================

export const HEARTBEAT_TIMEOUT_MS = 360000; // 6 minutes - agent considered offline after this
export const API_TIMEOUT_MS = 30000; // 30 seconds
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 1000;

// ============================================================================
// API Key Configuration
// ============================================================================

export const API_KEY_PREFIX = 'milo_';
export const API_KEY_LENGTH = 32;

// ============================================================================
// File Limits
// ============================================================================

export const MAX_MESSAGE_LENGTH = 10000;
export const MAX_SESSION_NAME_LENGTH = 255;
export const MAX_AGENT_NAME_LENGTH = 100;

// ============================================================================
// Workspace Paths
// ============================================================================

export const DEFAULT_WORKSPACE_DIR = '~/milo-workspace';
export const DEFAULT_PROJECTS_DIR = 'projects';
export const DEFAULT_SESSIONS_DIR = 'SESSIONS';
export const DEFAULT_TEMPLATES_DIR = 'templates';
export const DEFAULT_TOOLS_DIR = 'TOOLS';
export const DEFAULT_SKILLS_DIR = 'SKILLS';
