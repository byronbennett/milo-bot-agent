import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createFileTools } from './file-tools.js';
import { createBashTool } from './bash-tool.js';
import { createSearchTools } from './search-tools.js';
import { createGitTools } from './git-tools.js';
import { createNotifyTool } from './notify-tool.js';
import { createCliAgentTools } from './cli-agent-tools.js';
// DISABLED: OAuth-based use of the `claude` CLI binary is forbidden by Claude Code TOS
// when invoked by an orchestrating agent. Only the API-key-based SDK is permitted.
// import { createClaudeCodeOAuthTool } from './claude-code-oauth-tool.js';
import { createBrowserTool } from './browser-tool.js';
import { createWebFetchTool } from './web-fetch-tool.js';
import { createSetProjectTool } from './project-tool.js';
import { createFormTool, type FormToolContext } from './form-tool.js';
import { createUsageTool } from './usage-tool.js';
import { createSendFileTool } from './send-file-tool.js';
import { loadToolKey } from '../utils/keychain.js';

export { isDangerousCommand } from './bash-tool.js';

export type ToolSet = 'full' | 'chat' | 'minimal' | string[];

export interface ToolContext {
  projectPath: string;
  workspaceDir: string;
  sessionId: string;
  sessionName: string;
  currentTaskId: () => string | null;
  preferAPIKeyClaude?: boolean;
  sendNotification: (message: string) => void;
  askUser: (opts: {
    toolCallId: string;
    question: string;
    options?: string[];
  }) => Promise<string>;
  sendIpcEvent?: (event: {
    type: 'tool_start' | 'tool_end' | 'stream_text' | 'progress';
    toolName?: string;
    toolCallId?: string;
    delta?: string;
    message?: string;
    success?: boolean;
    summary?: string;
  }) => void;
  sendFile?: (opts: {
    filename: string;
    content: string;
    encoding: 'utf-8' | 'base64' | 'gzip+base64';
    mimeType: string;
    sizeBytes: number;
  }) => void;
  requestForm?: FormToolContext['requestForm'];
  onProjectSet?: (projectName: string, projectPath: string, isNew: boolean) => void;
}

export function loadTools(toolSet: ToolSet, ctx: ToolContext): AgentTool<any>[] {
  const coreTools = [
    ...createFileTools(ctx.projectPath),
    createBashTool(ctx.projectPath),
    ...createSearchTools(ctx.projectPath),
    ...createGitTools(ctx.projectPath),
  ];
  // DISABLED: OAuth-based `claude` CLI tool is forbidden by Claude Code TOS when
  // invoked by an orchestrating agent. Always use the API-key-based SDK tools.
  // const cliTools = ctx.preferAPIKeyClaude
  //   ? createCliAgentTools(ctx)
  //   : [createClaudeCodeOAuthTool(ctx), ...createCliAgentTools(ctx).filter((t) => t.name !== 'claude_code')];
  const cliTools = createCliAgentTools(ctx);
  const uiTools = [createNotifyTool(ctx.sendNotification)];
  const setProjectTool = createSetProjectTool(ctx, {
    onProjectSet: (projectName, newProjectPath, isNew) => {
      ctx.onProjectSet?.(projectName, newProjectPath, isNew);
    },
  });
  const formTools = ctx.requestForm ? [createFormTool({ requestForm: ctx.requestForm })] : [];
  const usageTools = ctx.requestForm
    ? [createUsageTool({ loadAdminKey: (name) => loadToolKey('usage', name), requestForm: ctx.requestForm })]
    : [];
  const sendFileTools = ctx.sendFile
    ? [createSendFileTool({ sendFile: ctx.sendFile })]
    : [];

  switch (toolSet) {
    case 'full':
      return [...coreTools, createWebFetchTool(), setProjectTool, ...cliTools, uiTools[0], createBrowserTool(), ...formTools, ...usageTools, ...sendFileTools];
    case 'chat':
      return [...uiTools];
    case 'minimal':
      return [...coreTools, createWebFetchTool(), setProjectTool, ...uiTools, ...formTools, ...usageTools, ...sendFileTools];
    default:
      if (Array.isArray(toolSet)) {
        const all = [...coreTools, createWebFetchTool(), setProjectTool, ...cliTools, ...uiTools, createBrowserTool(), ...formTools, ...usageTools, ...sendFileTools];
        return all.filter((t) => toolSet.includes(t.name));
      }
      return [...coreTools, createWebFetchTool(), ...uiTools, ...formTools, ...usageTools, ...sendFileTools];
  }
}
