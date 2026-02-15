/**
 * Claude Code Bridge — DEPRECATED
 *
 * This module is deprecated. The new architecture uses pi-agent-core
 * via the orchestrator/worker process model.
 *
 * These stubs exist only to prevent import errors in legacy code paths
 * (agent.ts, task/executor.ts) that have not yet been fully migrated.
 */

import type {
  CCSession,
  CCSessionStatus,
  CCSessionOptions,
  CCPromptOptions,
  CCPromptResult,
  CCQuestion,
} from './types';

const DEPRECATED_MSG = 'claude-code bridge is deprecated. Use the orchestrator/worker architecture with pi-agent-core instead.';

export async function openSession(_options: CCSessionOptions): Promise<CCSession> {
  throw new Error(DEPRECATED_MSG);
}

export async function sendPrompt(
  _sessionId: string,
  _prompt: string,
  _options?: CCPromptOptions,
): Promise<CCPromptResult> {
  throw new Error(DEPRECATED_MSG);
}

export function getSession(_sessionId: string): CCSession | null {
  return null;
}

export function getStatus(_sessionId: string): CCSessionStatus | null {
  return null;
}

export function getPendingQuestion(_sessionId: string): CCQuestion | null {
  return null;
}

export async function sendAnswer(_sessionId: string, _answer: string): Promise<boolean> {
  throw new Error(DEPRECATED_MSG);
}

export function abort(_sessionId: string): boolean {
  return false;
}

export function closeSession(_sessionId: string): boolean {
  return false;
}

export function listActiveSessions(): CCSession[] {
  return [];
}

export function getActiveSessionCount(): number {
  return 0;
}

export async function waitForReady(
  _sessionId: string,
  _maxRetries?: number,
  _retryIntervalMs?: number,
): Promise<boolean> {
  return false;
}
