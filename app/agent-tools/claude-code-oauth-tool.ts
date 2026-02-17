/**
 * Claude Code OAuth Tool
 *
 * Spawns the `claude` CLI binary directly using `-p` (print/headless) mode,
 * which inherits the user's existing OAuth session from `claude login`.
 * No ANTHROPIC_API_KEY needed.
 *
 * The NDJSON events from `claude -p --output-format stream-json` use the
 * same message types (system, stream_event, assistant, result) as the SDK,
 * so the shared handleMessage() function is reused.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from './index.js';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { handleMessage } from './claude-event-handler.js';
import { assertProjectConfirmed } from './project-guard.js';

const ClaudeOAuthParams = Type.Object({
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
  model: Type.Optional(
    Type.String({ description: 'Model to use, e.g. "sonnet", "opus". Omit for default.' }),
  ),
});

// Track known session IDs for resume validation
const knownSessionIds = new Set<string>();

// Cache the resolved claude binary path
let cachedClaudeBinary: string | null = null;

const PROCESS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Find the `claude` CLI binary.
 * Checks: PATH (via `which`), ~/.claude/bin/claude, common install paths.
 */
async function findClaudeBinary(): Promise<string> {
  if (cachedClaudeBinary) return cachedClaudeBinary;

  // 1. Try PATH via `which`
  const whichResult = await new Promise<string | null>((resolve) => {
    const proc = spawn('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });

  if (whichResult) {
    cachedClaudeBinary = whichResult;
    return whichResult;
  }

  // 2. Check common locations
  const candidates = [
    join(homedir(), '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedClaudeBinary = candidate;
      return candidate;
    }
  }

  throw new Error(
    'Claude CLI binary not found. Please install it:\n' +
    '  npm install -g @anthropic-ai/claude-code\n' +
    'Then authenticate with:\n' +
    '  claude login',
  );
}

/**
 * Kill a child process with escalating signals.
 */
function escalatingKill(proc: ChildProcess): void {
  try { proc.kill('SIGINT'); } catch { /* already dead */ }

  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* */ }
    }
  }, 4000);

  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch { /* */ }
    }
  }, 7000);
}

export function createClaudeCodeOAuthTool(ctx: ToolContext): AgentTool<typeof ClaudeOAuthParams> {
  return {
    name: 'claude_code',
    label: 'Claude Code (OAuth)',
    description:
      'Delegate a complex coding task to Claude Code CLI using your OAuth session (no API key needed). ' +
      'Best for multi-file refactors, large features, or tasks that benefit from Claude Code\'s specialized coding capabilities. ' +
      'Supports multi-turn conversations: the first call returns a session_id, pass it back on subsequent calls to continue the conversation.',
    parameters: ClaudeOAuthParams,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const claudeBinary = await findClaudeBinary();
      const cwd = params.workingDirectory ?? ctx.projectPath;
      assertProjectConfirmed(cwd, ctx.workspaceDir);
      const isResume = params.sessionId && knownSessionIds.has(params.sessionId);

      onUpdate?.({
        content: [{
          type: 'text',
          text: isResume
            ? `Resuming Claude Code session ${params.sessionId}...`
            : 'Starting new Claude Code session (OAuth)...',
        }],
        details: {},
      });

      // Build args
      const args = [
        '-p', params.prompt,
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
      ];

      if (isResume && params.sessionId) {
        args.push('-r', params.sessionId);
      }

      if (params.model) {
        args.push('--model', params.model);
      }

      // Strip ANTHROPIC_API_KEY to ensure OAuth is used
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const startTime = Date.now();

      // Spawn the claude process
      const proc = spawn(claudeBinary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      // Wire abort signal
      const onAbort = () => escalatingKill(proc);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Process timeout
      const timeout = setTimeout(() => {
        escalatingKill(proc);
      }, PROCESS_TIMEOUT_MS);

      let sessionId: string | undefined;
      let resultMessage: SDKResultMessage | undefined;
      let lastAssistantText = '';
      let stderrOutput = '';

      // Collect stderr
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      // Parse NDJSON from stdout
      await new Promise<void>((resolve, reject) => {
        let buffer = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          let idx: number;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;

            try {
              const message = JSON.parse(line);
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
            } catch {
              // Non-JSON line, skip
            }
          }
        });

        proc.on('close', (code) => {
          clearTimeout(timeout);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }

          if (code !== 0 && !resultMessage) {
            // Check for auth-related errors
            const lowerStderr = stderrOutput.toLowerCase();
            if (lowerStderr.includes('auth') || lowerStderr.includes('login') || lowerStderr.includes('token')) {
              reject(new Error(
                `Claude Code authentication failed. Please run:\n  claude login\n\nStderr: ${stderrOutput.slice(0, 500)}`,
              ));
              return;
            }
            reject(new Error(
              `Claude Code exited with code ${code}.\nStderr: ${stderrOutput.slice(0, 500)}`,
            ));
            return;
          }

          resolve();
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        });
      });

      const durationMs = Date.now() - startTime;

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
          duration_ms: resultMessage?.duration_ms ?? durationMs,
          num_turns: resultMessage?.num_turns,
        },
      };
    },
  };
}
