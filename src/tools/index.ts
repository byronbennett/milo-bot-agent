/**
 * Tools Module
 *
 * Exports for tool discovery, registration, and execution.
 */

export {
  registerTool,
  getTool,
  listTools,
  hasTool,
  unregisterTool,
  clearRegistry,
  discoverTools,
  getToolCount,
} from './registry';

export {
  executeTool,
  executeToolSequence,
  isToolSafe,
  getToolDescription,
  type ExecuteToolOptions,
} from './executor';

export type {
  ToolMeta,
  ToolArg,
  ToolResult,
  ToolContext,
  ToolSource,
  RegisteredTool,
  ToolExecutor,
  ToolFileType,
  SkillDefinition,
} from './types';
