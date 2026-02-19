import { spawn } from 'child_process';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from './index.js';
import type {
  SDKResultMessage,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import { shouldAutoAnswer } from '../auto-answer/index.js';
import { handleMessage, extractTextFromContent } from './claude-event-handler.js';
import { assertProjectConfirmed } from './project-guard.js';
import {
  findCodexBinary,
  buildCodexArgs,
  escalatingKill,
  CODEX_TIMEOUT_MS,
} from './codex-cli-runtime.js';
import {
  handleCodexEvent,
  parseCodexLine,
  type CodexEventState,
} from './codex-event-handler.js';

const ClaudeCodeParams = Type.Object({
  prompt: Type.String({ description: 'Detailed task description or follow-up message for Claude Code' }),
  sessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing Claude Code session by ID. Omit to start a new session. ' +
        'Use this to continue a multi-turn conversation with Claude Code.',
    }),
  ),
  workingDirectory: Type.Optional(
    Type.String({ description: 'Override working directory (default: project directory)' }),
  ),
});

const CodexParams = Type.Object({
  prompt: Type.String({ description: 'Detailed task description or follow-up message for Codex CLI' }),
  sessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing Codex session by thread ID. Omit to start a new session. ' +
        'Use this to continue a multi-turn conversation with Codex.',
    }),
  ),
  workingDirectory: Type.Optional(
    Type.String({ description: 'Override working directory (default: project directory)' }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Override model (default: gpt-5.3-codex). Examples: o3, gpt-5.3-codex' }),
  ),
});

const SimplePromptParams = Type.Object({
  prompt: Type.String({ description: 'Task description' }),
});

// Track known session IDs for resume validation
const knownSessionIds = new Set<string>();
const knownCodexSessionIds = new Set<string>();

/**
 * Build the canUseTool callback for Claude Code Agent SDK.
 *
 * - For AskUserQuestion: try auto-answer first, then forward to user
 * - For all other tools: allow (bypassPermissions handles most cases)
 */
function buildCanUseTool(ctx: ToolContext) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') {
      const question = typeof input.question === 'string'
        ? input.question
        : JSON.stringify(input);

      // Extract options from AskUserQuestion input
      let questionOptions: string[] | undefined;
      if (Array.isArray(input.questions)) {
        // AskUserQuestion has a questions array with options
        const q = input.questions[0] as Record<string, unknown> | undefined;
        if (q && Array.isArray(q.options)) {
          questionOptions = (q.options as Array<{ label?: string }>).map(
            (o) => o.label ?? String(o),
          );
        }
      }

      // Step 1: Try auto-answer
      const autoResult = await shouldAutoAnswer(question, {
        workspaceDir: ctx.workspaceDir,
      });

      if (autoResult.shouldAnswer && autoResult.answer) {
        return {
          behavior: 'deny',
          message: autoResult.answer,
        };
      }

      // Step 2: Forward to user
      const answer = await ctx.askUser({
        toolCallId: options.toolUseID,
        question,
        options: questionOptions,
      });

      return {
        behavior: 'deny',
        message: answer,
      };
    }

    // All other tools: allow
    return { behavior: 'allow', updatedInput: input };
  };
}

export function createCliAgentTools(ctx: ToolContext): AgentTool<any>[] {
  const claudeCodeTool: AgentTool<typeof ClaudeCodeParams> = {
    name: 'claude_code',
    label: 'Claude Code (AI Coding Agent)',
    description:
      'Delegate a coding task to Claude Code, Anthropic\'s AI coding agent. Claude Code can read/write files, run commands, search codebases, and execute multi-step coding workflows autonomously. ' +
      'Use this for any coding work: writing features, fixing bugs, refactoring, running tests, git operations, and more. ' +
      'Supports multi-turn conversations: the first call returns a session_id, pass it back on subsequent calls to continue the conversation.',
    parameters: ClaudeCodeParams,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const cwd = params.workingDirectory ?? ctx.projectPath;
      assertProjectConfirmed(cwd, ctx.workspaceDir);
      const isResume = params.sessionId && knownSessionIds.has(params.sessionId);

      onUpdate?.({
        content: [{
          type: 'text',
          text: isResume
            ? `Resuming Claude Code session ${params.sessionId}...`
            : 'Starting new Claude Code session...',
        }],
        details: {},
      });

      // Build abort controller wired to incoming signal
      const abortController = new AbortController();
      if (signal) {
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }

      const queryOptions: Record<string, unknown> = {
        cwd,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        canUseTool: buildCanUseTool(ctx),
        abortController,
        includePartialMessages: true,
      };

      if (isResume) {
        queryOptions.resume = params.sessionId;
      }

      let sessionId: string | undefined;
      let resultMessage: SDKResultMessage | undefined;
      let lastAssistantText = '';

      for await (const message of query({ prompt: params.prompt, options: queryOptions })) {
        handleMessage(message, ctx, {
          onSessionId: (id) => {
            sessionId = id;
            knownSessionIds.add(id);
          },
          onResultMessage: (msg) => {
            resultMessage = msg;
          },
          onAssistantText: (text) => {
            lastAssistantText = text;
          },
        });
      }

      // Build output from result
      let output: string;
      if (resultMessage && resultMessage.subtype === 'success') {
        output = resultMessage.result || lastAssistantText || 'Task completed.';
      } else if (resultMessage && 'errors' in resultMessage) {
        output = `Claude Code ended with errors: ${resultMessage.errors.join(', ')}`;
      } else {
        output = lastAssistantText || 'No output from Claude Code.';
      }

      const finalSessionId = sessionId ?? (resultMessage as any)?.session_id;

      return {
        content: [{
          type: 'text',
          text: output +
            (finalSessionId
              ? `\n\n[Claude Code session_id: ${finalSessionId} — pass this to continue the conversation]`
              : ''),
        }],
        details: {
          session_id: finalSessionId,
          cost_usd: resultMessage?.total_cost_usd,
          duration_ms: resultMessage?.duration_ms,
          num_turns: resultMessage?.num_turns,
        },
      };
    },
  };

  const geminiCliTool: AgentTool<typeof SimplePromptParams> = {
    name: 'gemini_cli',
    label: 'Gemini CLI',
    description: 'Delegate a task to Google Gemini CLI (not yet implemented).',
    parameters: SimplePromptParams,
    execute: async (_toolCallId, _params) => {
      assertProjectConfirmed(ctx.projectPath, ctx.workspaceDir);
      throw new Error('Gemini CLI integration is not yet implemented.');
    },
  };

  const codexCliTool: AgentTool<typeof CodexParams> = {
    name: 'codex_cli',
    label: 'OpenAI Codex CLI (AI Coding Agent)',
    description:
      'Delegate a coding task to OpenAI Codex CLI, an AI coding agent. Codex can read/write files, run commands, and execute multi-step coding workflows. ' +
      'Use this for coding tasks when you want to leverage OpenAI models (o3, gpt-5.3-codex, etc.). ' +
      'Supports multi-turn conversations: the first call returns a session_id (thread ID), pass it back on subsequent calls to continue the conversation.',
    parameters: CodexParams,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const codexBinary = await findCodexBinary();
      const cwd = params.workingDirectory ?? ctx.projectPath;
      assertProjectConfirmed(cwd, ctx.workspaceDir);
      const isResume = params.sessionId && knownCodexSessionIds.has(params.sessionId);

      onUpdate?.({
        content: [{
          type: 'text',
          text: isResume
            ? `Resuming Codex CLI session ${params.sessionId}...`
            : 'Starting new Codex CLI session...',
        }],
        details: {},
      });

      // Build args
      const args = buildCodexArgs({
        prompt: params.prompt,
        cwd,
        sessionId: isResume ? params.sessionId : undefined,
        model: params.model,
      });

      // Set up environment: copy process.env, ensure CODEX_API_KEY is set
      const env = { ...process.env };
      if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) {
        env.CODEX_API_KEY = env.OPENAI_API_KEY;
      }

      const startTime = Date.now();

      // Spawn the codex process
      const proc = spawn(codexBinary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      // Wire abort signal
      const onAbort = () => escalatingKill(proc);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const cleanupAbort = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      proc.on('close', cleanupAbort);

      // Process timeout
      const timeout = setTimeout(() => {
        escalatingKill(proc);
      }, CODEX_TIMEOUT_MS);

      // State for event handling
      const state: CodexEventState = { lastAssistantText: '', errors: [] };
      let sessionId: string | undefined;
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
                sessionId = id;
                knownCodexSessionIds.add(id);
              },
              onAssistantText: () => { /* state tracks this */ },
              onUsage: (u) => {
                usage = u;
              },
              onError: () => { /* state tracks this */ },
              sendIpcEvent: (evt) => {
                ctx.sendIpcEvent?.(evt);
              },
            }, state);
          }
        });

        proc.on('close', (code) => {
          clearTimeout(timeout);

          if (code !== 0 && !state.lastAssistantText && state.errors.length === 0) {
            // Check for auth-related errors in stderr
            const lowerStderr = stderrOutput.toLowerCase();
            if (lowerStderr.includes('auth') || lowerStderr.includes('api_key') || lowerStderr.includes('token') || lowerStderr.includes('unauthorized')) {
              reject(new Error(
                `Codex CLI authentication failed. Please ensure OPENAI_API_KEY is set, or run:\n  codex login\n\nStderr: ${stderrOutput.slice(0, 500)}`,
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
          reject(err);
        });
      });

      const durationMs = Date.now() - startTime;

      // Build output
      let output: string;
      if (state.errors.length > 0 && !state.lastAssistantText) {
        output = `Codex CLI ended with errors: ${state.errors.join('; ')}`;
      } else if (state.lastAssistantText) {
        output = state.lastAssistantText;
      } else {
        output = 'No output from Codex CLI.';
      }

      return {
        content: [{
          type: 'text',
          text: output +
            (sessionId
              ? `\n\n[Codex CLI session_id: ${sessionId} — pass this to continue the conversation]`
              : ''),
        }],
        details: {
          session_id: sessionId,
          usage,
          duration_ms: durationMs,
        },
      };
    },
  };

  return [claudeCodeTool, geminiCliTool, codexCliTool];
}

