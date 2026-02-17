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

const SimplePromptParams = Type.Object({
  prompt: Type.String({ description: 'Task description' }),
});

// Track known session IDs for resume validation
const knownSessionIds = new Set<string>();

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
    name: 'claude_code_cli',
    label: 'Claude Code',
    description:
      'Delegate a complex coding task to Claude Code CLI. Best for multi-file refactors, large features, or tasks that benefit from Claude Code\'s specialized coding capabilities. ' +
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

  const codexCliTool: AgentTool<typeof SimplePromptParams> = {
    name: 'codex_cli',
    label: 'OpenAI Codex CLI',
    description: 'Delegate a task to OpenAI Codex CLI (not yet implemented).',
    parameters: SimplePromptParams,
    execute: async (_toolCallId, _params) => {
      assertProjectConfirmed(ctx.projectPath, ctx.workspaceDir);
      throw new Error('Codex CLI integration is not yet implemented.');
    },
  };

  return [claudeCodeTool, geminiCliTool, codexCliTool];
}

