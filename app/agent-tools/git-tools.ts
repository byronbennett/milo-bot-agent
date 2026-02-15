import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const EmptyParams = Type.Object({});

const GitDiffParams = Type.Object({
  staged: Type.Optional(Type.Boolean({ description: 'Show staged changes only' })),
  file: Type.Optional(Type.String({ description: 'Diff a specific file' })),
});

const GitCommitParams = Type.Object({
  message: Type.String({ description: 'Commit message' }),
  files: Type.Optional(Type.Array(Type.String(), { description: 'Files to stage (default: all changed)' })),
});

const GitLogParams = Type.Object({
  count: Type.Optional(Type.Number({ description: 'Number of commits to show (default: 10)' })),
});

export function createGitTools(projectPath: string): AgentTool<any>[] {
  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectPath,
      timeout: 30_000,
    });
    return stdout.trim();
  }

  const gitStatusTool: AgentTool<typeof EmptyParams> = {
    name: 'git_status',
    label: 'Git Status',
    description: 'Show the working tree status (git status).',
    parameters: EmptyParams,
    execute: async () => {
      const output = await git('status');
      return { content: [{ type: 'text', text: output }], details: {} };
    },
  };

  const gitDiffTool: AgentTool<typeof GitDiffParams> = {
    name: 'git_diff',
    label: 'Git Diff',
    description: 'Show changes in the working directory (git diff). Optionally diff staged changes.',
    parameters: GitDiffParams,
    execute: async (_toolCallId, params) => {
      const args = ['diff'];
      if (params.staged) args.push('--staged');
      if (params.file) args.push(params.file);
      const output = await git(...args);
      return { content: [{ type: 'text', text: output || '(no changes)' }], details: {} };
    },
  };

  const gitCommitTool: AgentTool<typeof GitCommitParams> = {
    name: 'git_commit',
    label: 'Git Commit',
    description: 'Stage files and create a git commit.',
    parameters: GitCommitParams,
    execute: async (_toolCallId, params) => {
      if (params.files && params.files.length > 0) {
        await git('add', ...params.files);
      } else {
        await git('add', '-A');
      }
      const output = await git('commit', '-m', params.message);
      return { content: [{ type: 'text', text: output }], details: {} };
    },
  };

  const gitLogTool: AgentTool<typeof GitLogParams> = {
    name: 'git_log',
    label: 'Git Log',
    description: 'Show recent commit history.',
    parameters: GitLogParams,
    execute: async (_toolCallId, params) => {
      const n = params.count ?? 10;
      const output = await git('log', `--oneline`, `-${n}`);
      return { content: [{ type: 'text', text: output }], details: {} };
    },
  };

  return [gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool];
}
