import {
  buildCodexArgs,
  CODEX_TIMEOUT_MS,
} from '../../app/agent-tools/codex-cli-runtime.js';

describe('codex-cli-runtime', () => {
  // -------------------------------------------------------------------------
  // buildCodexArgs
  // -------------------------------------------------------------------------

  describe('buildCodexArgs', () => {
    it('builds correct args for a new session', () => {
      const args = buildCodexArgs({
        prompt: 'fix the tests',
        cwd: '/home/user/project',
      });

      expect(args).toEqual([
        '-a', 'never',
        '-s', 'workspace-write',
        '-C', '/home/user/project',
        'exec', '--json', '--skip-git-repo-check',
        'fix the tests',
      ]);
    });

    it('builds correct args for a resume session', () => {
      const args = buildCodexArgs({
        prompt: 'continue with linting',
        cwd: '/home/user/project',
        sessionId: 'thread-abc-123',
      });

      expect(args).toEqual([
        '-a', 'never',
        '-s', 'workspace-write',
        '-C', '/home/user/project',
        'exec', '--json', '--skip-git-repo-check',
        'resume', 'thread-abc-123', 'continue with linting',
      ]);
    });

    it('includes -m model before exec when model is provided', () => {
      const args = buildCodexArgs({
        prompt: 'refactor utils',
        cwd: '/tmp/repo',
        model: 'o3',
      });

      expect(args).toEqual([
        '-a', 'never',
        '-s', 'workspace-write',
        '-C', '/tmp/repo',
        '-m', 'o3',
        'exec', '--json', '--skip-git-repo-check',
        'refactor utils',
      ]);
    });

    it('includes both model and resume in correct positions', () => {
      const args = buildCodexArgs({
        prompt: 'add error handling',
        cwd: '/workspace/app',
        sessionId: 'thread-xyz-789',
        model: 'gpt-4.1',
      });

      expect(args).toEqual([
        '-a', 'never',
        '-s', 'workspace-write',
        '-C', '/workspace/app',
        '-m', 'gpt-4.1',
        'exec', '--json', '--skip-git-repo-check',
        'resume', 'thread-xyz-789', 'add error handling',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // CODEX_TIMEOUT_MS
  // -------------------------------------------------------------------------

  describe('CODEX_TIMEOUT_MS', () => {
    it('is exactly 1800000 ms (30 minutes)', () => {
      expect(CODEX_TIMEOUT_MS).toBe(1_800_000);
    });
  });
});
