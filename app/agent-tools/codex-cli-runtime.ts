/**
 * Codex CLI runtime helpers — binary discovery, argument building, process kill.
 *
 * These are extracted from the tool so they can be tested independently and
 * reused by both the tool definition and the worker.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time a Codex CLI process may run before being killed (30 min). */
export const CODEX_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodexArgs {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

let cachedBinary: string | null = null;

/**
 * Find the `codex` CLI binary.
 * Checks: PATH (via `which`), common install paths.
 */
export async function findCodexBinary(): Promise<string> {
  if (cachedBinary) return cachedBinary;

  // 1. Try PATH via `which`
  const whichResult = await new Promise<string | null>((resolve) => {
    const proc = spawn('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });

  if (whichResult) {
    cachedBinary = whichResult;
    return whichResult;
  }

  // 2. Check common locations
  const candidates = [
    join(homedir(), '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }

  throw new Error(
    'Codex CLI binary not found. Please install it:\n' +
    '  npm install -g @openai/codex\n' +
    'Then authenticate with:\n' +
    '  Set OPENAI_API_KEY environment variable, or run: codex login',
  );
}

/** Reset the cached binary path (useful for testing). */
export function resetBinaryCache(): void {
  cachedBinary = null;
}

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

/**
 * Build the CLI argument array for a `codex` invocation.
 *
 * New session:
 *   codex -a never -s workspace-write -C <cwd> [-m model] exec --json --skip-git-repo-check <prompt>
 *
 * Resume session:
 *   codex -a never -s workspace-write -C <cwd> [-m model] exec --json --skip-git-repo-check resume <sessionId> <prompt>
 */
export function buildCodexArgs(opts: CodexArgs): string[] {
  const { prompt, cwd, sessionId, model } = opts;

  const modelArgs = model ? ['-m', model] : [];

  if (sessionId) {
    return [
      '-a', 'never',
      '-s', 'workspace-write',
      '-C', cwd,
      ...modelArgs,
      'exec', '--json', '--skip-git-repo-check',
      'resume', sessionId, prompt,
    ];
  }

  return [
    '-a', 'never',
    '-s', 'workspace-write',
    '-C', cwd,
    ...modelArgs,
    'exec', '--json', '--skip-git-repo-check',
    prompt,
  ];
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/**
 * Kill a child process with escalating signals:
 * - Immediately: SIGINT
 * - After 4 s: SIGTERM (if still alive)
 * - After 7 s: SIGKILL (if still alive)
 */
export function escalatingKill(proc: ChildProcess): void {
  try { proc.kill('SIGINT'); } catch { /* already dead */ }

  const t1 = setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* */ }
    }
  }, 4000);
  t1.unref();

  const t2 = setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch { /* */ }
    }
  }, 7000);
  t2.unref();
}
