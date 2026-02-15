import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\s/i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bdrop\s+(table|database)/i,
  /\bsudo\s/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

const BashParams = Type.Object({
  command: Type.String({ description: 'The shell command to run' }),
});

export function createBashTool(projectPath: string): AgentTool<typeof BashParams> {
  return {
    name: 'bash',
    label: 'Run Command',
    description: 'Execute a shell command in the project directory. Returns stdout and stderr.',
    parameters: BashParams,
    execute: async (_toolCallId, params, signal) => {
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', params.command], {
          cwd: projectPath,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 10,
          signal: signal as AbortSignal,
        });

        const output = [stdout, stderr].filter(Boolean).join('\n---stderr---\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { command: params.command },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Command failed: ${msg}`);
      }
    },
  };
}
