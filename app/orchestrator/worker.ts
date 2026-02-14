/**
 * Worker process entry point.
 *
 * Spawned by the orchestrator as a child process.
 * Communicates via JSON Lines on stdin (receive) / stdout (send).
 * Stderr is reserved for logging (piped to orchestrator's logger).
 *
 * Lifecycle:
 *   1. Receive WORKER_INIT → initialize session context → send WORKER_READY
 *   2. Receive WORKER_TASK → execute → send WORKER_TASK_DONE
 *   3. Receive WORKER_CANCEL → abort current task → send WORKER_TASK_CANCELLED
 *   4. Receive WORKER_CLOSE → cleanup → exit(0)
 *
 * Orphan handling:
 *   If stdin closes (orchestrator dies), the worker checks whether a sub-agent
 *   is running. If so, it waits up to 30 minutes for it to finish before exiting.
 *
 * Usage: node --import tsx/esm app/orchestrator/worker.ts
 */

import { sendIPC, readIPC } from './ipc.js';
import type {
  WorkerInitMessage,
  WorkerTaskMessage,
  WorkerCancelMessage,
  WorkerToOrchestrator,
} from './ipc-types.js';
import { sendNotification } from '../utils/notify.js';

const ORPHAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Worker state
let sessionId = '';
let sessionName = '';
let sessionType: 'chat' | 'bot' = 'bot';
let projectPath = '';
let workspaceDir = '';
let initialized = false;
let currentTaskId: string | null = null;
let cancelRequested = false;
let orphanHandled = false;

// Claude Code session (lazy, kept alive across tasks)
let claudeSession: unknown = null;

function send(msg: WorkerToOrchestrator): void {
  sendIPC(process.stdout, msg);
}

function log(message: string): void {
  process.stderr.write(`[worker:${sessionId || 'init'}] ${message}\n`);
}

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  sessionId = msg.sessionId;
  sessionName = msg.sessionName;
  sessionType = msg.sessionType;
  projectPath = msg.projectPath;
  workspaceDir = msg.workspaceDir;

  // Set API keys if provided
  if (msg.config.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = msg.config.anthropicApiKey;
  }

  initialized = true;
  log(`Initialized (type=${sessionType}, project=${projectPath})`);

  send({ type: 'WORKER_READY', sessionId, pid: process.pid });
}

async function handleTask(msg: WorkerTaskMessage): Promise<void> {
  if (!initialized) {
    send({ type: 'WORKER_ERROR', sessionId, error: 'Worker not initialized', fatal: true });
    return;
  }

  currentTaskId = msg.taskId;
  cancelRequested = false;

  send({ type: 'WORKER_TASK_STARTED', taskId: msg.taskId, sessionId });
  log(`Task started: ${msg.taskId}`);

  try {
    let output: string;

    if (sessionType === 'chat') {
      output = await executeChatTask(msg);
    } else {
      output = await executeClaudeCodeTask(msg);
    }

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
    } else {
      send({
        type: 'WORKER_TASK_DONE',
        taskId: msg.taskId,
        sessionId,
        success: true,
        output,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Task failed: ${error}`);

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
    } else {
      send({
        type: 'WORKER_TASK_DONE',
        taskId: msg.taskId,
        sessionId,
        success: false,
        error,
      });
    }
  } finally {
    currentTaskId = null;
    cancelRequested = false;
    // Signal readiness for next task
    send({ type: 'WORKER_READY', sessionId, pid: process.pid });
  }
}

async function handleCancel(_msg: WorkerCancelMessage): Promise<void> {
  log(`Cancel requested for task: ${currentTaskId}`);
  cancelRequested = true;

  // If we have a Claude Code session, abort it
  if (claudeSession && typeof (claudeSession as { abort?: () => void }).abort === 'function') {
    (claudeSession as { abort: () => void }).abort();
  }

  // The running task's try/catch will pick up cancelRequested and send WORKER_TASK_CANCELLED
}

async function executeChatTask(msg: WorkerTaskMessage): Promise<string> {
  // Dynamic import to avoid loading Anthropic SDK until needed
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const ai = new Anthropic();

  const messages = msg.context?.chatHistory ?? [];
  messages.push({ role: 'user', content: msg.prompt });

  const response = await ai.messages.create({
    model: process.env.AI_MODEL || 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    system: 'You are MiloBot, a helpful coding assistant. Be concise and helpful.',
    messages,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : 'No response generated.';
}

async function executeClaudeCodeTask(msg: WorkerTaskMessage): Promise<string> {
  // Dynamic import to avoid loading SDK until needed
  const { ClaudeCode } = await import('claude-code-js');

  // Reuse or create Claude Code instance
  if (!claudeSession) {
    const claude = new ClaudeCode({ workingDirectory: projectPath });
    claudeSession = claude.newSession();
  }

  const session = claudeSession as { prompt: (opts: { prompt: string }) => Promise<{ result?: string; cost_usd?: number; duration_ms?: number }> };

  const response = await session.prompt({ prompt: msg.prompt });
  return response.result ?? 'No output from Claude Code.';
}

// --- Orphan handling ---

/**
 * Write an audit log entry directly to the worker's own DB connection.
 * Safe to use when orchestrator is dead — WAL mode handles concurrent access.
 */
async function writeOrphanAuditLog(content: string): Promise<void> {
  if (!workspaceDir || !sessionId) return;

  try {
    const { getDb } = await import('../db/index.js');
    const { insertSessionMessage } = await import('../db/sessions-db.js');
    const db = getDb(workspaceDir);
    insertSessionMessage(db, sessionId, 'system', content);
  } catch (err) {
    log(`Failed to write orphan audit log: ${err}`);
  }
}

/**
 * Handle the orphan state when orchestrator connection is lost (stdin EOF).
 * If a sub-agent is running, wait up to 30 minutes for it to finish.
 */
async function handleOrphanState(): Promise<void> {
  if (orphanHandled) return;
  orphanHandled = true;

  log('Orchestrator connection lost (stdin EOF). Entering orphan state.');

  await writeOrphanAuditLog('Orchestrator connection lost. Worker entering orphan state.');
  sendNotification(
    'MiloBot Worker Orphaned',
    `Session "${sessionName || sessionId}" lost orchestrator connection.`,
  );

  if (!currentTaskId && !claudeSession) {
    log('No sub-agent running. Exiting.');
    await writeOrphanAuditLog('No sub-agent running. Exiting.');
    process.exit(1);
    return;
  }

  log(`Sub-agent running (task: ${currentTaskId}). Waiting up to 30 minutes for completion.`);
  await writeOrphanAuditLog(`Sub-agent running (task: ${currentTaskId}). Waiting up to 30 minutes for completion.`);

  const deadline = Date.now() + ORPHAN_TIMEOUT_MS;

  const poll = setInterval(async () => {
    if (!currentTaskId && !claudeSession) {
      clearInterval(poll);
      log('Sub-agent completed. Exiting orphaned worker.');
      await writeOrphanAuditLog('Sub-agent completed. Exiting orphaned worker.');
      process.exit(0);
    }
    if (Date.now() > deadline) {
      clearInterval(poll);
      log('Orphan timeout reached (30 min). Force exiting.');
      await writeOrphanAuditLog('Orphan timeout reached (30 min). Force exiting.');
      process.exit(1);
    }
  }, 5000);
}

/**
 * Monitor stdin for EOF independently of the message loop.
 * This fires when the orchestrator process dies or closes the pipe.
 */
function monitorStdinEOF(): void {
  process.stdin.on('end', () => {
    handleOrphanState();
  });
}

// --- Main loop ---

async function main(): Promise<void> {
  log('Worker process starting...');

  monitorStdinEOF();

  for await (const msg of readIPC(process.stdin)) {
    switch (msg.type) {
      case 'WORKER_INIT':
        await handleInit(msg);
        break;
      case 'WORKER_TASK':
        await handleTask(msg);
        break;
      case 'WORKER_CANCEL':
        await handleCancel(msg);
        break;
      case 'WORKER_CLOSE':
        log('Close requested, exiting...');
        process.exit(0);
        break;
      default:
        log(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  // stdin closed — let the orphan handler decide what to do
  // (monitorStdinEOF will have already fired or will fire shortly)
  await handleOrphanState();
}

main().catch((err) => {
  process.stderr.write(`[worker] Fatal error: ${err}\n`);
  process.exit(1);
});
