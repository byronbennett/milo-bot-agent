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
 * Usage: node --import tsx/esm app/orchestrator/worker.ts
 */

import { sendIPC, readIPC } from './ipc.js';
import type {
  WorkerInitMessage,
  WorkerTaskMessage,
  WorkerCancelMessage,
  WorkerToOrchestrator,
} from './ipc-types.js';

// Worker state
let sessionId = '';
let sessionName = '';
let sessionType: 'chat' | 'bot' = 'bot';
let projectPath = '';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let workspaceDir = '';
let initialized = false;
let currentTaskId: string | null = null;
let cancelRequested = false;

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

// --- Main loop ---

async function main(): Promise<void> {
  log('Worker process starting...');

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

  // stdin closed — orchestrator died or closed pipe
  log('stdin closed, exiting...');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[worker] Fatal error: ${err}\n`);
  process.exit(1);
});
