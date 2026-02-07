/**
 * Claude Code Bridge Module
 *
 * Exports for interacting with Claude Code sessions.
 */

export {
  openSession,
  sendPrompt,
  getSession,
  getStatus,
  getPendingQuestion,
  sendAnswer,
  abort,
  closeSession,
  listActiveSessions,
  getActiveSessionCount,
  waitForReady,
} from './bridge';

export type {
  CCSession,
  CCSessionStatus,
  CCSessionOptions,
  CCPromptOptions,
  CCPromptResult,
  CCQuestion,
} from './types';
