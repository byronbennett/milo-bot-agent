/**
 * Claude Code Bridge Types
 *
 * Types for interacting with Claude Code sessions.
 */

/**
 * Status of a Claude Code session
 */
export type CCSessionStatus =
  | 'starting'
  | 'ready'
  | 'working'
  | 'waiting_for_answer'
  | 'completed'
  | 'failed'
  | 'aborted';

/**
 * Claude Code session information
 */
export interface CCSession {
  id: string;
  projectPath: string;
  status: CCSessionStatus;
  startedAt: Date;
  lastActivityAt: Date;
  pendingQuestion?: CCQuestion;
  error?: string;
}

/**
 * A question from Claude Code waiting for user answer
 */
export interface CCQuestion {
  id: string;
  question: string;
  options?: string[];
  askedAt: Date;
}

/**
 * Result of a Claude Code prompt
 */
export interface CCPromptResult {
  success: boolean;
  result?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Options for creating a Claude Code session
 */
export interface CCSessionOptions {
  projectPath: string;
  systemPrompt?: string;
  verbose?: boolean;
}

/**
 * Options for sending a prompt
 */
export interface CCPromptOptions {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  timeout?: number;
}
