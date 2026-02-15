import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const ListFilesParams = Type.Object({
  path: Type.Optional(Type.String({ description: 'Directory path (default: project root)' })),
  pattern: Type.Optional(Type.String({ description: 'Glob pattern to filter (e.g., "**/*.ts")' })),
  maxDepth: Type.Optional(Type.Number({ description: 'Max directory depth (default: 3)' })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: 'Regex pattern to search for' }),
  path: Type.Optional(Type.String({ description: 'Directory or file to search in (default: project root)' })),
  glob: Type.Optional(Type.String({ description: 'File glob filter (e.g., "*.ts")' })),
});

export function createSearchTools(projectPath: string): AgentTool<any>[] {
  const listFilesTool: AgentTool<typeof ListFilesParams> = {
    name: 'list_files',
    label: 'List Files',
    description: 'List files in a directory, optionally with a glob pattern. Returns file paths relative to project root.',
    parameters: ListFilesParams,
    execute: async (_toolCallId, params) => {
      const dir = params.path ?? '.';
      const maxDepth = params.maxDepth ?? 3;
      const files: string[] = [];

      function walk(currentPath: string, depth: number) {
        if (depth > maxDepth) return;
        try {
          const entries = readdirSync(join(projectPath, currentPath));
          for (const entry of entries) {
            if (entry.startsWith('.') || entry === 'node_modules') continue;
            const relPath = join(currentPath, entry);
            const stat = statSync(join(projectPath, relPath));
            if (stat.isDirectory()) {
              files.push(relPath + '/');
              walk(relPath, depth + 1);
            } else {
              files.push(relPath);
            }
          }
        } catch { /* skip unreadable dirs */ }
      }

      walk(dir === '.' ? '' : dir, 0);
      return {
        content: [{ type: 'text', text: files.join('\n') || '(empty directory)' }],
        details: { count: files.length },
      };
    },
  };

  const grepTool: AgentTool<typeof GrepParams> = {
    name: 'grep',
    label: 'Search Content',
    description: 'Search file contents using grep. Returns matching lines with file paths and line numbers.',
    parameters: GrepParams,
    execute: async (_toolCallId, params, signal) => {
      const searchPath = params.path ?? '.';
      const args = ['-rn', '--max-count=50'];
      if (params.glob) args.push('--include', params.glob);
      args.push(params.pattern, searchPath);

      try {
        const { stdout } = await execFileAsync('grep', args, {
          cwd: projectPath,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          signal: signal as AbortSignal,
        });
        return {
          content: [{ type: 'text', text: stdout || 'No matches found.' }],
          details: { pattern: params.pattern },
        };
      } catch (err: unknown) {
        const exitErr = err as { code?: number; stdout?: string };
        if (exitErr.code === 1) {
          return {
            content: [{ type: 'text', text: 'No matches found.' }],
            details: { pattern: params.pattern },
          };
        }
        throw err;
      }
    },
  };

  return [listFilesTool, grepTool];
}
