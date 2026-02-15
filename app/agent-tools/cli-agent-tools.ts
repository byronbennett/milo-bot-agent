import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const ClaudeCodeParams = Type.Object({
  prompt: Type.String({ description: 'Detailed task description for Claude Code' }),
  workingDirectory: Type.Optional(
    Type.String({ description: 'Override working directory (default: project directory)' }),
  ),
});

const SimplePromptParams = Type.Object({
  prompt: Type.String({ description: 'Task description' }),
});

export function createCliAgentTools(projectPath: string): AgentTool<any>[] {
  const claudeCodeTool: AgentTool<typeof ClaudeCodeParams> = {
    name: 'claude_code_cli',
    label: 'Claude Code',
    description:
      'Delegate a complex coding task to Claude Code CLI. Best for multi-file refactors, large features, or tasks that benefit from Claude Code\'s specialized coding capabilities.',
    parameters: ClaudeCodeParams,
    execute: async (_toolCallId, params, _signal, onUpdate) => {
      let ClaudeCode;
      try {
        const mod = await import('claude-code-js');
        ClaudeCode = mod.ClaudeCode;
      } catch {
        throw new Error(
          'claude-code-js is not installed. Install it with: pnpm add claude-code-js',
        );
      }

      onUpdate?.({
        content: [{ type: 'text', text: 'Delegating to Claude Code...' }],
        details: {},
      });

      const claude = new ClaudeCode({
        workingDirectory: params.workingDirectory ?? projectPath,
      });
      const session = claude.newSession();
      const result = await session.prompt({ prompt: params.prompt });

      return {
        content: [{ type: 'text', text: result.result ?? 'No output from Claude Code.' }],
        details: {
          cost_usd: result.cost_usd,
          duration_ms: result.duration_ms,
        },
      };
    },
  };

  const geminiCliTool: AgentTool<typeof SimplePromptParams> = {
    name: 'gemini_cli',
    label: 'Gemini CLI',
    description: 'Delegate a task to Google Gemini CLI (not yet implemented).',
    parameters: SimplePromptParams,
    execute: async () => {
      throw new Error('Gemini CLI integration is not yet implemented.');
    },
  };

  const codexCliTool: AgentTool<typeof SimplePromptParams> = {
    name: 'codex_cli',
    label: 'OpenAI Codex CLI',
    description: 'Delegate a task to OpenAI Codex CLI (not yet implemented).',
    parameters: SimplePromptParams,
    execute: async () => {
      throw new Error('Codex CLI integration is not yet implemented.');
    },
  };

  return [claudeCodeTool, geminiCliTool, codexCliTool];
}
