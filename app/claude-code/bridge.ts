/**
 * Claude Code Bridge
 *
 * Wrapper for the claude-code-js SDK to interact with Claude Code sessions.
 * Manages session lifecycle, prompt sending, and question handling.
 */

import { ClaudeCode } from 'claude-code-js';
import { logger } from '../utils/logger';
import type {
  CCSession,
  CCSessionStatus,
  CCSessionOptions,
  CCPromptOptions,
  CCPromptResult,
  CCQuestion,
} from './types';

/**
 * Internal session state tracked by the bridge
 */
interface SessionState {
  session: CCSession;
  claude: ClaudeCode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkSession: any; // The claude-code-js session object
}

/**
 * Active sessions managed by the bridge
 */
const sessions = new Map<string, SessionState>();

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Open a new Claude Code session in a project directory
 *
 * @param options - Session configuration
 * @returns The created session
 */
export async function openSession(options: CCSessionOptions): Promise<CCSession> {
  const sessionId = generateSessionId();
  const now = new Date();

  logger.info(`Opening Claude Code session ${sessionId} in ${options.projectPath}`);

  try {
    // Initialize Claude Code SDK
    const claude = new ClaudeCode({
      workingDirectory: options.projectPath,
      verbose: options.verbose ?? false,
    });

    // Create a new session
    const sdkSession = claude.newSession();

    const session: CCSession = {
      id: sessionId,
      projectPath: options.projectPath,
      status: 'ready',
      startedAt: now,
      lastActivityAt: now,
    };

    sessions.set(sessionId, {
      session,
      claude,
      sdkSession,
    });

    logger.info(`Claude Code session ${sessionId} ready`);
    return session;
  } catch (error) {
    logger.error(`Failed to open Claude Code session:`, error);
    throw new Error(`Failed to open Claude Code session: ${error}`);
  }
}

/**
 * Send a prompt to an active Claude Code session
 *
 * @param sessionId - The session ID
 * @param prompt - The prompt to send
 * @param options - Prompt options
 * @returns The result of the prompt
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  options: CCPromptOptions = {}
): Promise<CCPromptResult> {
  const state = sessions.get(sessionId);
  if (!state) {
    return { success: false, error: `Session ${sessionId} not found` };
  }

  logger.debug(`Sending prompt to session ${sessionId}: ${prompt.slice(0, 100)}...`);

  try {
    // Update status
    state.session.status = 'working';
    state.session.lastActivityAt = new Date();

    // Send prompt to Claude Code
    const response = await state.sdkSession.prompt({
      prompt,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
    });

    // Update session state
    state.session.status = 'ready';
    state.session.lastActivityAt = new Date();

    return {
      success: true,
      result: response.result,
      costUsd: response.cost_usd,
      durationMs: response.duration_ms,
    };
  } catch (error) {
    logger.error(`Prompt failed in session ${sessionId}:`, error);
    state.session.status = 'failed';
    state.session.error = String(error);

    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Get the current status of a session
 *
 * @param sessionId - The session ID
 * @returns The session or null if not found
 */
export function getSession(sessionId: string): CCSession | null {
  const state = sessions.get(sessionId);
  return state?.session ?? null;
}

/**
 * Get the status of a session
 *
 * @param sessionId - The session ID
 * @returns The status or null if not found
 */
export function getStatus(sessionId: string): CCSessionStatus | null {
  const state = sessions.get(sessionId);
  return state?.session.status ?? null;
}

/**
 * Get pending question from Claude Code (if any)
 *
 * Note: The claude-code-js SDK handles questions internally.
 * This is a placeholder for future interactive mode support.
 *
 * @param sessionId - The session ID
 * @returns The pending question or null
 */
export function getPendingQuestion(sessionId: string): CCQuestion | null {
  const state = sessions.get(sessionId);
  return state?.session.pendingQuestion ?? null;
}

/**
 * Send an answer to a pending question
 *
 * Note: The claude-code-js SDK handles questions internally.
 * This is a placeholder for future interactive mode support.
 *
 * @param sessionId - The session ID
 * @param answer - The answer to send
 * @returns Success status
 */
export async function sendAnswer(
  sessionId: string,
  answer: string
): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state) {
    logger.warn(`Cannot send answer: session ${sessionId} not found`);
    return false;
  }

  if (!state.session.pendingQuestion) {
    logger.warn(`No pending question in session ${sessionId}`);
    return false;
  }

  logger.debug(`Sending answer to session ${sessionId}: ${answer}`);

  // For now, we continue the conversation with the answer as a prompt
  const result = await sendPrompt(sessionId, answer);

  // Clear the pending question
  state.session.pendingQuestion = undefined;

  return result.success;
}

/**
 * Abort a Claude Code session
 *
 * @param sessionId - The session ID
 * @returns Success status
 */
export function abort(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) {
    logger.warn(`Cannot abort: session ${sessionId} not found`);
    return false;
  }

  logger.info(`Aborting Claude Code session ${sessionId}`);

  state.session.status = 'aborted';
  state.session.lastActivityAt = new Date();

  // Remove from active sessions
  sessions.delete(sessionId);

  return true;
}

/**
 * Close a session and mark as completed
 *
 * @param sessionId - The session ID
 * @returns Success status
 */
export function closeSession(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) {
    return false;
  }

  logger.info(`Closing Claude Code session ${sessionId}`);

  state.session.status = 'completed';
  state.session.lastActivityAt = new Date();

  // Remove from active sessions
  sessions.delete(sessionId);

  return true;
}

/**
 * List all active sessions
 *
 * @returns Array of active sessions
 */
export function listActiveSessions(): CCSession[] {
  return Array.from(sessions.values()).map((s) => s.session);
}

/**
 * Get the number of active sessions
 *
 * @returns Number of active sessions
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}

/**
 * Wait for a session to be ready
 *
 * @param sessionId - The session ID
 * @param maxRetries - Maximum retries
 * @param retryIntervalMs - Retry interval in milliseconds
 * @returns True if ready, false if timeout
 */
export async function waitForReady(
  sessionId: string,
  maxRetries = 10,
  retryIntervalMs = 1000
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const status = getStatus(sessionId);

    if (status === 'ready') {
      return true;
    }

    if (status === 'failed' || status === 'aborted' || status === null) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
  }

  return false;
}
