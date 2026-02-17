/**
 * Worker process entry point.
 *
 * Spawned by the orchestrator as a child process.
 * Communicates via JSON Lines on stdin (receive) / stdout (send).
 *
 * Each worker runs one pi-agent-core Agent instance that persists across tasks.
 * The agent's persona and model can change per-message — when they do, the agent
 * is recreated with the new system prompt and model.
 */

import { sendIPC, readIPC } from './ipc.js';
import type {
  WorkerInitMessage,
  WorkerTaskMessage,
  WorkerCancelMessage,
  WorkerSteerMessage,
  WorkerAnswerMessage,
  WorkerToOrchestrator,
} from './ipc-types.js';
import { sendNotification } from '../utils/notify.js';

const ORPHAN_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_SYSTEM_PROMPT = 'You are MiloBot, a helpful AI coding agent. You are working on tasks for your user remotely.';

// Worker state
let sessionId = '';
let sessionName = '';
let projectPath = '';
let workspaceDir = '';
let initialized = false;
let currentTaskId: string | null = null;
let cancelRequested = false;
let orphanHandled = false;
let projectChanged = false;

// pi-agent-core Agent (lazy, kept alive across tasks)
let agent: import('@mariozechner/pi-agent-core').Agent | null = null;

// Pending answers for tool safety questions
const pendingAnswers = new Map<string, (answer: string) => void>();

// Per-message persona/model tracking
let currentPersonaId: string | undefined;
let currentPersonaVersionId: string | undefined;
let currentModel: string | undefined;

// Config from WORKER_INIT
let apiUrl = '';
let apiKey = '';
let personasDir = '';
let skillsDir = '';
let streaming = false;
let initConfig: WorkerInitMessage['config'] = {
  apiUrl: '',
  apiKey: '',
  personasDir: '',
  skillsDir: '',
};

function send(msg: WorkerToOrchestrator): void {
  sendIPC(process.stdout, msg);
}

function log(message: string): void {
  process.stderr.write(`[worker:${sessionId || 'init'}] ${message}\n`);
}

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  sessionId = msg.sessionId;
  sessionName = msg.sessionName;
  projectPath = msg.projectPath;
  workspaceDir = msg.workspaceDir;
  initConfig = msg.config;
  apiUrl = msg.config.apiUrl;
  apiKey = msg.config.apiKey;
  personasDir = msg.config.personasDir;
  skillsDir = msg.config.skillsDir;
  streaming = msg.config.streaming ?? false;

  initialized = true;
  log(`Initialized (project=${projectPath})`);

  send({ type: 'WORKER_READY', sessionId, pid: process.pid });
}

/**
 * Create or recreate the pi-agent-core Agent with the given system prompt and model.
 */
async function createAgent(systemPromptText: string | null, modelId: string | null): Promise<void> {
  const { Agent } = await import('@mariozechner/pi-agent-core');
  const { getModel } = await import('@mariozechner/pi-ai');
  const { loadTools } = await import('../agent-tools/index.js');
  const { join } = await import('path');
  const { readFileSync, existsSync } = await import('fs');

  // Build system prompt
  const sections: string[] = [];

  sections.push(systemPromptText ?? DEFAULT_SYSTEM_PROMPT);

  sections.push(`## Current Session\n- Working directory: ${projectPath}\n- Session: ${sessionName}`);

  sections.push(`## Your Capabilities
You have tools for file operations, shell commands, git, and code search.
You also have access to CLI coding agents (Claude Code, Gemini CLI, Codex CLI) that you can delegate complex multi-step tasks to.
If a destructive action is needed, your tools will ask the user for confirmation.
Always use the notify_user tool to communicate important progress or results to the user.

## Critical Behavioral Rules

### Rule 1: Honor Your Own Plans
If you outline a plan or steps to the user, you MUST follow those exact steps in order. Never skip steps. If you told the user you would ask clarifying questions first, you MUST ask those questions and STOP — do not proceed to later steps until the user has answered. Your plan is a commitment, not a suggestion.

### Rule 2: Clarify Before Acting on Ambiguous Tasks
For tasks that involve subjective choices, personal preferences, or multiple valid approaches, ask clarifying questions FIRST. Present your questions clearly, then end your response. Do NOT proceed with the work until the user has answered. Examples of when to ask:
- The user's experience level, preferences, or constraints are unknown
- The task could be interpreted multiple ways
- The output depends on personal taste or requirements

### Rule 3: Report Tool Failures Transparently
If a tool call fails or errors, you MUST tell the user what happened. Never silently fall back to doing the work yourself without the tool. Specifically:
- Tell the user which tool failed and why
- Explain what you can do instead (e.g., "Claude Code CLI is unavailable, I can try doing this directly but the results may be less thorough")
- Ask the user if they want you to proceed with the fallback approach
Do NOT pretend the tool succeeded or silently produce inferior output.

### Rule 4: Do Not Fabricate Research
When asked to research something (find YouTube channels, compare options, gather real-world data), you MUST use your tools (browser, web search) to find real information. Never make up channel names, URLs, view counts, or other factual claims. If you cannot access the information, tell the user honestly.`);

  // Load project context
  const claudeMdPath = join(projectPath, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    sections.push(`## Project Context (CLAUDE.md)\n${claudeMd}`);
  }

  // Load user preferences
  const memoryPath = join(workspaceDir, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    const memory = readFileSync(memoryPath, 'utf-8');
    sections.push(`## User Preferences\n${memory}`);
  }

  // Load available skills
  if (skillsDir) {
    const { buildSkillsPromptSection } = await import('../skills/skills-registry.js');
    const skillsSection = buildSkillsPromptSection(skillsDir);
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  const systemPrompt = sections.join('\n\n');

  // Resolve model
  const provider = initConfig.agentProvider ?? 'anthropic';
  const resolvedModelId = modelId ?? initConfig.agentModel ?? 'claude-sonnet-4-20250514';
  const model = getModel(provider as any, resolvedModelId as any);

  // Resolve tool set
  const toolSet = initConfig.toolSet ?? 'full';
  const tools = loadTools(toolSet as any, {
    projectPath,
    workspaceDir,
    sessionId,
    sessionName,
    currentTaskId: () => currentTaskId,
    preferAPIKeyClaude: initConfig.preferAPIKeyClaude,
    sendNotification: (message: string) => {
      send({
        type: 'WORKER_PROGRESS',
        taskId: currentTaskId ?? '',
        sessionId,
        message,
      });
    },
    askUser: ({ toolCallId, question, options }) => {
      return new Promise<string>((resolve) => {
        pendingAnswers.set(toolCallId, resolve);
        send({
          type: 'WORKER_QUESTION',
          sessionId,
          taskId: currentTaskId ?? '',
          toolCallId,
          question,
          options,
        });
      });
    },
    sendIpcEvent: (event) => {
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
    },
    onProjectSet: (projectName: string, newProjectPath: string, isNew: boolean) => {
      projectPath = newProjectPath;
      projectChanged = true;
      send({
        type: 'WORKER_PROJECT_SET',
        sessionId,
        projectName,
        projectPath: newProjectPath,
        isNew,
      });
    },
  });

  agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
    },
    convertToLlm: (messages) =>
      messages.filter((m) => 'role' in m && ['user', 'assistant', 'toolResult'].includes((m as any).role)),
    transformContext: async (messages) => {
      const maxMessages = 100;
      if (messages.length <= maxMessages) return messages;
      const head = messages.slice(0, 2);
      const tail = messages.slice(-maxMessages + 2);
      return [
        ...head,
        { role: 'user' as const, content: `[Earlier: ${messages.length - maxMessages} messages pruned]`, timestamp: Date.now() },
        ...tail,
      ];
    },
  });

  // Subscribe to events for IPC forwarding
  agent.subscribe((event) => {
    if (!currentTaskId) return;

    switch (event.type) {
      case 'message_update':
        if (streaming && event.assistantMessageEvent?.type === 'text_delta') {
          send({
            type: 'WORKER_STREAM_TEXT',
            sessionId,
            taskId: currentTaskId,
            delta: event.assistantMessageEvent.delta,
          });
        }
        break;

      case 'tool_execution_start':
        send({
          type: 'WORKER_TOOL_START',
          sessionId,
          taskId: currentTaskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;

      case 'tool_execution_end':
        send({
          type: 'WORKER_TOOL_END',
          sessionId,
          taskId: currentTaskId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          success: !event.isError,
          summary: typeof event.result?.content?.[0] === 'object' && event.result?.content?.[0]?.type === 'text'
            ? event.result.content[0].text.slice(0, 200)
            : undefined,
        });
        break;
    }
  });

  log(`Agent created (model=${resolvedModelId}, tools=${tools.length})`);
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
    // Check if persona or model changed — if so, recreate the agent
    const personaChanged =
      msg.personaId !== currentPersonaId ||
      msg.personaVersionId !== currentPersonaVersionId;
    const modelChanged = msg.model !== currentModel;
    const needsRecreate = !agent || personaChanged || modelChanged || projectChanged;

    log(`Task ${msg.taskId}: prompt="${msg.prompt.slice(0, 100)}" agentExists=${!!agent} personaChanged=${personaChanged} modelChanged=${modelChanged} needsRecreate=${needsRecreate}`);
    log(`  msg.personaId=${msg.personaId ?? 'undefined'} msg.personaVersionId=${msg.personaVersionId ?? 'undefined'} msg.model=${msg.model ?? 'undefined'}`);
    log(`  current: personaId=${currentPersonaId ?? 'undefined'} personaVersionId=${currentPersonaVersionId ?? 'undefined'} model=${currentModel ?? 'undefined'}`);

    if (needsRecreate) {
      // Resolve persona system prompt
      let systemPromptText: string | null = null;

      if (msg.personaId && msg.personaVersionId) {
        const { resolvePersona } = await import('../personas/resolver.js');
        systemPromptText = await resolvePersona({
          personasDir,
          personaId: msg.personaId,
          personaVersionId: msg.personaVersionId,
          apiUrl,
          apiKey,
        });
        log(`Persona resolved: ${msg.personaId}@${msg.personaVersionId}`);
      }

      const resolvedModel = msg.model ?? initConfig.agentModel ?? 'claude-sonnet-4-20250514';
      log(`Creating agent with model=${resolvedModel} provider=${initConfig.agentProvider ?? 'anthropic'}`);
      await createAgent(systemPromptText, resolvedModel);

      // Update tracking
      currentPersonaId = msg.personaId;
      currentPersonaVersionId = msg.personaVersionId;
      currentModel = msg.model;
      projectChanged = false;
    }

    const promptStart = Date.now();
    log(`Calling agent.prompt()...`);
    log(`  Model: ${currentModel ?? initConfig.agentModel ?? '(default)'}`);
    log(`  System prompt (${agent!.state.systemPrompt.length} chars):\n${agent!.state.systemPrompt}`);
    log(`  User prompt: ${msg.prompt}`);
    await agent!.prompt(msg.prompt);
    const promptDuration = Date.now() - promptStart;
    log(`agent.prompt() completed in ${promptDuration}ms`);

    if (cancelRequested) {
      send({ type: 'WORKER_TASK_CANCELLED', taskId: msg.taskId, sessionId });
    } else {
      // Extract final assistant text
      const messages = agent!.state.messages;
      log(`Agent has ${messages.length} messages after prompt`);
      const lastAssistant = [...messages].reverse().find((m) => 'role' in m && (m as any).role === 'assistant');
      let output = '';
      if (lastAssistant && 'content' in lastAssistant) {
        if (typeof lastAssistant.content === 'string') {
          output = lastAssistant.content;
        } else if (Array.isArray(lastAssistant.content)) {
          output = (lastAssistant.content as any[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
        }
      }

      if (!output) {
        log(`WARNING: No assistant output extracted. lastAssistant=${lastAssistant ? JSON.stringify(lastAssistant).slice(0, 500) : 'null'}`);
      } else {
        log(`Output (${output.length} chars): "${output.slice(0, 200)}"`);
      }

      send({
        type: 'WORKER_TASK_DONE',
        taskId: msg.taskId,
        sessionId,
        success: true,
        output: output || 'Task completed.',
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
    send({ type: 'WORKER_READY', sessionId, pid: process.pid });
  }
}

async function handleCancel(_msg: WorkerCancelMessage): Promise<void> {
  log(`Cancel requested for task: ${currentTaskId}`);
  cancelRequested = true;

  if (agent) {
    agent.abort();
  }
}

function handleSteer(msg: WorkerSteerMessage): void {
  if (agent) {
    log(`Steering: ${msg.prompt.slice(0, 80)}...`);
    agent.steer({ role: 'user', content: msg.prompt, timestamp: Date.now() });
  }
}

function handleAnswer(msg: WorkerAnswerMessage): void {
  const resolver = pendingAnswers.get(msg.toolCallId);
  if (resolver) {
    resolver(msg.answer);
    pendingAnswers.delete(msg.toolCallId);
  }
}

// --- Orphan handling ---

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

async function handleOrphanState(): Promise<void> {
  if (orphanHandled) return;
  orphanHandled = true;

  log('Orchestrator connection lost (stdin EOF). Entering orphan state.');
  await writeOrphanAuditLog('Orchestrator connection lost. Worker entering orphan state.');
  sendNotification(
    'MiloBot Worker Orphaned',
    `Session "${sessionName || sessionId}" lost orchestrator connection.`,
  );

  if (!currentTaskId && !agent?.state.isStreaming) {
    log('No task running. Exiting.');
    await writeOrphanAuditLog('No task running. Exiting.');
    process.exit(1);
    return;
  }

  log(`Task running (${currentTaskId}). Waiting up to 30 minutes.`);
  await writeOrphanAuditLog(`Task running (${currentTaskId}). Waiting up to 30 minutes.`);

  const deadline = Date.now() + ORPHAN_TIMEOUT_MS;
  const poll = setInterval(async () => {
    if (!currentTaskId && !agent?.state.isStreaming) {
      clearInterval(poll);
      log('Task completed. Exiting orphaned worker.');
      await writeOrphanAuditLog('Task completed. Exiting orphaned worker.');
      process.exit(0);
    }
    if (Date.now() > deadline) {
      clearInterval(poll);
      log('Orphan timeout reached (30 min). Force exiting.');
      await writeOrphanAuditLog('Orphan timeout reached. Force exiting.');
      process.exit(1);
    }
  }, 5000);
}

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
        // Don't await — run in background so cancel/steer/answer messages
        // can be processed while the task is executing
        handleTask(msg).catch((err) => {
          log(`Unhandled task error: ${err}`);
          send({ type: 'WORKER_ERROR', sessionId, error: String(err), fatal: true });
        });
        break;
      case 'WORKER_CANCEL':
        await handleCancel(msg);
        break;
      case 'WORKER_STEER':
        handleSteer(msg);
        break;
      case 'WORKER_ANSWER':
        handleAnswer(msg);
        break;
      case 'WORKER_CLOSE':
        log('Close requested, exiting...');
        process.exit(0);
        break;
      default:
        log(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  await handleOrphanState();
}

main().catch((err) => {
  process.stderr.write(`[worker] Fatal error: ${err}\n`);
  process.exit(1);
});
