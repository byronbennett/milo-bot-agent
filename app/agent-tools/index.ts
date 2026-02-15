import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createFileTools } from './file-tools.js';
import { createBashTool } from './bash-tool.js';
import { createSearchTools } from './search-tools.js';
import { createGitTools } from './git-tools.js';
import { createNotifyTool } from './notify-tool.js';
import { createCliAgentTools } from './cli-agent-tools.js';
import { createBrowserTool } from './browser-tool.js';

export { isDangerousCommand } from './bash-tool.js';

export type ToolSet = 'full' | 'chat' | 'minimal' | string[];

export interface ToolContext {
  projectPath: string;
  sendNotification: (message: string) => void;
}

export function loadTools(toolSet: ToolSet, ctx: ToolContext): AgentTool<any>[] {
  const coreTools = [
    ...createFileTools(ctx.projectPath),
    createBashTool(ctx.projectPath),
    ...createSearchTools(ctx.projectPath),
    ...createGitTools(ctx.projectPath),
  ];
  const cliTools = createCliAgentTools(ctx.projectPath);
  const uiTools = [createNotifyTool(ctx.sendNotification)];

  switch (toolSet) {
    case 'full':
      return [...coreTools, ...cliTools, uiTools[0], createBrowserTool()];
    case 'chat':
      return [...uiTools];
    case 'minimal':
      return [...coreTools, ...uiTools];
    default:
      if (Array.isArray(toolSet)) {
        const all = [...coreTools, ...cliTools, ...uiTools, createBrowserTool()];
        return all.filter((t) => toolSet.includes(t.name));
      }
      return [...coreTools, ...uiTools];
  }
}
