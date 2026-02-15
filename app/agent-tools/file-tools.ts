import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, isAbsolute } from 'path';

const ReadFileParams = Type.Object({
  path: Type.String({ description: 'File path (absolute or project-relative)' }),
});

const WriteFileParams = Type.Object({
  path: Type.String({ description: 'File path (absolute or project-relative)' }),
  content: Type.String({ description: 'Content to write' }),
});

export function createFileTools(projectPath: string): AgentTool<any>[] {
  function resolve(p: string): string {
    return isAbsolute(p) ? p : join(projectPath, p);
  }

  const readFileTool: AgentTool<typeof ReadFileParams> = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file. Path can be absolute or relative to the project directory.',
    parameters: ReadFileParams,
    execute: async (_toolCallId, params) => {
      const fullPath = resolve(params.path);
      const content = await readFile(fullPath, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
        details: { path: fullPath, size: content.length },
      };
    },
  };

  const writeFileTool: AgentTool<typeof WriteFileParams> = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file, creating parent directories if needed. Overwrites existing files.',
    parameters: WriteFileParams,
    execute: async (_toolCallId, params) => {
      const fullPath = resolve(params.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Wrote ${params.content.length} characters to ${params.path}` }],
        details: { path: fullPath },
      };
    },
  };

  return [readFileTool, writeFileTool];
}
