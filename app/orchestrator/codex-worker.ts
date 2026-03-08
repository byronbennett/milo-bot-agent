/**
 * Codex CLI worker process.
 *
 * Spawned by the orchestrator as a child process for sessions with workerType 'codex'.
 * Communicates via JSON Lines on stdin (receive) / stdout (send) — same IPC protocol as worker.ts.
 *
 * Unlike the pi-agent-core worker, this process manages a Codex CLI binary directly.
 * Each user message spawns a `codex exec --json` process (or `codex exec resume <threadId>`)
 * and streams JSONL events back to the orchestrator.
 *
 * Key differences from worker.ts:
 * - No pi-agent-core Agent instance
 * - Each turn spawns a fresh codex process (Codex is not a long-lived process)
 * - No steering support (Codex doesn't accept mid-turn input)
 * - No context management — Codex manages its own thread state
 * - Persona instructions are prepended to the first-turn prompt
 */

// Strip NODE_OPTIONS so child processes don't inherit the tsx loader hook
delete process.env.NODE_OPTIONS;

import { spawn, type ChildProcess } from 'child_process';
import { sendIPC, readIPC } from './ipc.js';
import type {
  WorkerInitMessage,
  WorkerTaskMessage,
  WorkerToOrchestrator,
} from './ipc-types.js';
import {
  findCodexBinary,
  buildCodexArgs,
  buildEffectivePrompt,
  escalatingKill,
  CODEX_TIMEOUT_MS,
} from '../agent-tools/codex-cli-runtime.js';
import {
  handleCodexEvent,
  parseCodexLine,
  type CodexEventState,
} from '../agent-tools/codex-event-handler.js';
import { sendNotification } from '../utils/notify.js';

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let sessionId = '';
let sessionName = '';
let projectPath = '';
let workspaceDir = '';
let initialized = false;
let currentTaskId: string | null = null;
let cancelRequested = false;
let orphanHandled = false;

// Codex-specific state
let codexThreadId: string | undefined;
let personaInstructions: string | null = null;
let currentPersonaId: string | undefined;
let currentPersonaVersionId: string | undefined;

// Config
let apiUrl = '';
let apiKey = '';
let personasDir = '';
let codexModel: string | undefined;
let codexTimeoutMs = CODEX_TIMEOUT_MS;

// Active codex process (for cancellation)
let activeCodexProc: ChildProcess | null = null;

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function send(msg: WorkerToOrchestrator): void {
  sendIPC(process.stdout, msg);
}

function log(message: string): void {
  process.stderr.write(`[codex-worker:${sessionId || 'init'}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// IPC event forwarder (used by codex-event-handler)
// ---------------------------------------------------------------------------

function sendIpcEvent(event: {
  type: 'tool_start' | 'tool_end' | 'stream_text' | 'progress';
  toolName?: string;
  toolCallId?: string;
  delta?: string;
  message?: string;
  success?: boolean;
  summary?: string;
}): void {
  if (!currentTaskId) return;
  switch (event.type) {
    case 'stream_text':
      if (event.delta) {
        send({
          type: 'WORKER_STREAM_TEXT',
          sessionId,
          taskId: currentTaskId,
          delta: event.delta,
        });
      }
      break;
    case 'tool_start':
      if (event.toolName && event.toolCallId) {
        send({
          type: 'WORKER_TOOL_START',
          sessionId,
          taskId: currentTaskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
      }
      break;
    case 'tool_end':
      if (event.toolName && event.toolCallId) {
        send({
          type: 'WORKER_TOOL_END',
          sessionId,
          taskId: currentTaskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          success: event.success ?? true,
          summary: event.summary,
        });
      }
      break;
    case 'progress':
      if (event.message) {
        send({
          type: 'WORKER_PROGRESS',
          sessionId,
          taskId: currentTaskId,
          message: event.message,
        });
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  sessionId = msg.sessionId;
  sessionName = msg.sessionName;
  projectPath = msg.projectPath;
  workspaceDir = msg.workspaceDir;
  apiUrl = msg.config.apiUrl;
  apiKey = msg.config.apiKey;
  personasDir = msg.config.personasDir;
  codexModel = msg.config.codex?.defaultModel;
  codexTimeoutMs = msg.config.codex?.timeoutMs ?? CODEX_TIMEOUT_MS;

  // Restore persisted thread ID from orchestrator
  if (msg.codexThreadId) {
    codexThreadId = msg.codexThreadId;
    log(`Restored Codex thread: ${codexThreadId}`);
  }

  // Verify the codex binary exists early
  try {
    const binary = await findCodexBinary();
    log(`Codex binary found: ${binary}`);
  } catch (err) {
    log(`Codex binary not found: ${err}`);
    send({ type: 'WORKER_ERROR', sessionId, error: String(err), fatal: true });
    return;
  }

  initialized = true;
  log(`Initialized (project=${projectPath})`);

  send({
    type: 'WORKER_READY',
    sessionId,
    pid: process.pid,
    contextSize: { systemPromptTokens: 0, conversationTokens: 0, maxTokens: 0 },
  });
}

/**
 * Resolve persona instructions for the first turn.
 * On subsequent turns (resume), instructions are already part of the Codex thread context.
 */
async function resolvePersonaIfNeeded(
  personaId?: string,
  personaVersionId?: string,
): Promise<void> {
  const personaChanged =
    personaId !== currentPersonaId ||
    personaVersionId !== currentPersonaVersionId;

  if (!personaChanged && personaInstructions !== null) return;

  if (personaId && personaVersionId) {
    const { resolvePersona } = await import('../personas/resolver.js');
    personaInstructions = await resolvePersona({
      personasDir,
      personaId,
      personaVersionId,
      apiUrl,
      apiKey,
    });
    log(`Persona resolved: ${personaId}@${personaVersionId}`);
  } else {
    personaInstructions = null;
  }

  currentPersonaId = personaId;
  currentPersonaVersionId = personaVersionId;
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
    // Resolve persona instructions (only used on first turn of a thread)
    await resolvePersonaIfNeeded(msg.personaId, msg.personaVersionId);

    const codexBinary = await findCodexBinary();
    const model = msg.model ?? codexModel;

    // Build args — instructions are prepended to prompt on first turn only
    const args = buildCodexArgs({
      prompt: msg.prompt,
      cwd: projectPath,
      sessionId: codexThreadId,
      model,
      instructions: codexThreadId ? undefined : (personaInstructions ?? undefined),
    });

    // Set up environment
    const env = { ...process.env };
    if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) {
      env.CODEX_API_KEY = env.OPENAI_API_KEY;
    }

    const startTime = Date.now();
    const isResume = !!codexThreadId;
    log(`${isResume ? 'Resuming' : 'Starting'} Codex CLI (thread=${codexThreadId ?? 'new'}, model=${model ?? 'default'})`);

    // Spawn codex process
    const proc = spawn(codexBinary, args, {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    activeCodexProc = proc;

    // Process timeout
    const timeout = setTimeout(() => {
      log('Codex timeout reached, killing process');
      escalatingKill(proc);
    }, codexTimeoutMs);

    // Event state
    const state: CodexEventState = { lastAssistantText: '', errors: [] };
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    let stderrOutput = '';

    // Collect stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    // Parse JSONL from stdout
    await new Promise<void>((resolve, reject) => {
      let buffer = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);

          const event = parseCodexLine(line);
          if (!event) continue;

          handleCodexEvent(event, {
            onSessionId: (id) => {
              codexThreadId = id;
              // Report thread ID to orchestrator for persistence
              send({ type: 'WORKER_CODEX_THREAD', sessionId, threadId: id });
              log(`Codex thread ID: ${id}`);
            },
            onAssistantText: () => { /* state tracks this */ },
            onUsage: (u) => { usage = u; },
            onError: () => { /* state tracks this */ },
            sendIpcEvent,
          }, state);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        activeCodexProc = null;

        if (cancelRequested) {
          resolve();
          return;
        }

        if (code !== 0 && !state.lastAssistantText && state.errors.length === 0) {
          const lowerStderr = stderrOutput.toLowerCase();
          if (lowerStderr.includes('auth') || lowerStderr.includes('api_key') || lowerStderr.includes('token') || lowerStderr.includes('unauthorized')) {
            reject(new Error(
              `Codex CLI authentication failed. Ensure OPENAI_API_KEY is set or run: codex login\n\nStderr: ${stderrOutput.slice(0, 500)}`,
            ));
            return;
          }
          reject(new Error(
            `Codex CLI exited with code ${code}.\nStderr: ${stderrOutput.slice(0, 500)}`,
          ));
          return;
        }

        resolve();
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        activeCodexProc = null;
        reject(err);
      });
    });

    const durationMs = Date.now() - startTime;

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
      return;
    }

    // Build output
    let output: string;
    if (state.errors.length > 0 && !state.lastAssistantText) {
      output = `Codex CLI ended with errors: ${state.errors.join('; ')}`;
    } else if (state.lastAssistantText) {
      output = state.lastAssistantText;
    } else {
      output = 'Task completed (no text output from Codex).';
    }

    send({
      type: 'WORKER_TASK_DONE',
      taskId: msg.taskId,
      sessionId,
      success: state.errors.length === 0,
      output,
      durationMs,
    });
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
    send({
      type: 'WORKER_READY',
      sessionId,
      pid: process.pid,
      contextSize: { systemPromptTokens: 0, conversationTokens: 0, maxTokens: 0 },
    });
  }
}

function handleCancel(): void {
  log(`Cancel requested for task: ${currentTaskId}`);
  cancelRequested = true;

  if (activeCodexProc) {
    escalatingKill(activeCodexProc);
  }
}

// ---------------------------------------------------------------------------
// Orphan handling
// ---------------------------------------------------------------------------

async function handleOrphanState(): Promise<void> {
  if (orphanHandled) return;
  orphanHandled = true;

  log('Orchestrator connection lost (stdin EOF). Entering orphan state.');
  sendNotification(
    'MiloBot Codex Worker Orphaned',
    `Session "${sessionName || sessionId}" lost orchestrator connection.`,
  );

  if (!currentTaskId) {
    log('No task running. Exiting.');
    process.exit(1);
    return;
  }

  log(`Task running (${currentTaskId}). Waiting up to 30 minutes.`);
  const deadline = Date.now() + 30 * 60 * 1000;
  const poll = setInterval(() => {
    if (!currentTaskId) {
      clearInterval(poll);
      log('Task completed. Exiting orphaned worker.');
      process.exit(0);
    }
    if (Date.now() > deadline) {
      clearInterval(poll);
      log('Orphan timeout reached (30 min). Force exiting.');
      if (activeCodexProc) escalatingKill(activeCodexProc);
      process.exit(1);
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('Codex worker process starting...');

  process.stdin.on('end', () => {
    handleOrphanState();
  });

  for await (const msg of readIPC(process.stdin)) {
    switch (msg.type) {
      case 'WORKER_INIT':
        await handleInit(msg);
        break;
      case 'WORKER_TASK':
        handleTask(msg).catch((err) => {
          log(`Unhandled task error: ${err}`);
          send({ type: 'WORKER_ERROR', sessionId, error: String(err), fatal: true });
        });
        break;
      case 'WORKER_CANCEL':
        handleCancel();
        break;
      case 'WORKER_STEER':
        log('Steering not supported for Codex workers — message will be queued for next turn');
        break;
      case 'WORKER_CLEAR_CONTEXT':
        log('Clear context: resetting Codex thread');
        codexThreadId = undefined;
        personaInstructions = null;
        currentPersonaId = undefined;
        currentPersonaVersionId = undefined;
        send({
          type: 'WORKER_CONTEXT_CLEARED',
          sessionId,
          contextSize: { systemPromptTokens: 0, conversationTokens: 0, maxTokens: 0 },
        });
        break;
      case 'WORKER_COMPACT_CONTEXT':
        log('Compact context not supported for Codex workers');
        send({
          type: 'WORKER_ERROR',
          sessionId,
          error: 'Memory compaction is not supported for Codex sessions. Use "clear memory" to start a fresh thread.',
          fatal: false,
        });
        break;
      case 'WORKER_CLOSE':
        log('Close requested, exiting...');
        if (activeCodexProc) escalatingKill(activeCodexProc);
        process.exit(0);
        break;
      default:
        log(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  await handleOrphanState();
}

main().catch((err) => {
  process.stderr.write(`[codex-worker] Fatal error: ${err}\n`);
  process.exit(1);
});
