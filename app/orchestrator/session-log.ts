/**
 * Session log writer for worker processes.
 *
 * Appends timestamped markdown entries to a `log.md` file in the project folder.
 * Records all interactions: user messages, AI responses, tool executions,
 * steer messages, and other events — giving a persistent audit trail of
 * everything the worker did in a project.
 *
 * Only writes when a project path is set. All writes are synchronous to
 * avoid ordering issues with rapid sequential events.
 */

import { appendFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOG_FILENAME = 'log.md';

let logPath: string | null = null;
let headerWritten = false;

/**
 * Initialize the session log for a given project path.
 * Call this when the worker receives WORKER_INIT or when the project changes.
 */
export function initSessionLog(projectPath: string, sessionName?: string): void {
  if (!projectPath) {
    logPath = null;
    return;
  }

  logPath = join(projectPath, LOG_FILENAME);
  headerWritten = existsSync(logPath);

  if (!headerWritten) {
    writeFileSync(
      logPath,
      `# Session Log\n\n_Project: ${projectPath}_\n\n---\n\n`,
      'utf-8',
    );
    headerWritten = true;
  }

  appendEntry('session_start', `Session started: **${sessionName || 'unnamed'}**`);
}

/**
 * Update the log path when the project changes mid-session.
 */
export function updateSessionLogPath(newProjectPath: string): void {
  if (!newProjectPath) {
    logPath = null;
    return;
  }

  logPath = join(newProjectPath, LOG_FILENAME);

  if (!existsSync(logPath)) {
    writeFileSync(
      logPath,
      `# Session Log\n\n_Project: ${newProjectPath}_\n\n---\n\n`,
      'utf-8',
    );
  }
}

// ---------------------------------------------------------------------------
// Public logging methods
// ---------------------------------------------------------------------------

/** Log an incoming user/orchestrator message. */
export function logUserMessage(prompt: string): void {
  appendEntry('user', prompt);
}

/** Log a steer (mid-task follow-up) message from the user. */
export function logSteerMessage(prompt: string): void {
  appendEntry('steer', prompt);
}

/** Log the final AI response output. */
export function logAIResponse(output: string): void {
  appendEntry('ai', output);
}

/** Log an AI error response. */
export function logAIError(error: string): void {
  appendEntry('error', error);
}

/** Log a tool execution start. */
export function logToolStart(toolName: string, toolCallId: string): void {
  appendEntry('tool_start', `**${toolName}** (\`${toolCallId}\`)`);
}

/** Log a tool execution result. */
export function logToolEnd(toolName: string, success: boolean, summary?: string): void {
  const status = success ? 'completed' : 'failed';
  const detail = summary ? `\n> ${summary}` : '';
  appendEntry('tool_end', `**${toolName}** — ${status}${detail}`);
}

/** Log a question from the AI to the user. */
export function logQuestion(question: string): void {
  appendEntry('question', question);
}

/** Log an answer from the user to an AI question. */
export function logAnswer(answer: string): void {
  appendEntry('answer', answer);
}

/** Log a task cancellation. */
export function logCancelled(): void {
  appendEntry('cancelled', 'Task was cancelled.');
}

/** Log session close. */
export function logSessionClose(): void {
  appendEntry('session_end', 'Session closed.');
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const ENTRY_LABELS: Record<string, string> = {
  session_start: '🟢 Session',
  session_end: '🔴 Session',
  user: '👤 User',
  steer: '👤 Steer',
  ai: '🤖 AI Response',
  error: '❌ Error',
  tool_start: '🔧 Tool Start',
  tool_end: '🔧 Tool End',
  question: '❓ Question',
  answer: '💬 Answer',
  cancelled: '🚫 Cancelled',
};

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function appendEntry(type: string, content: string): void {
  if (!logPath) return;

  const label = ENTRY_LABELS[type] || type;
  const ts = timestamp();

  // Quote user/steer messages as blockquotes for readability
  let body: string;
  if (type === 'user' || type === 'steer' || type === 'question' || type === 'answer') {
    body = content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  } else {
    body = content;
  }

  const entry = `### ${ts} — ${label}\n\n${body}\n\n---\n\n`;

  try {
    appendFileSync(logPath, entry, 'utf-8');
  } catch {
    // Silently ignore write errors — logging should never crash the worker
  }
}
