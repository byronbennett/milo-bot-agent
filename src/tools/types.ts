/**
 * Tool Types
 *
 * Types for the tool discovery and execution system.
 */

/**
 * Tool argument definition
 */
export interface ToolArg {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Tool metadata
 */
export interface ToolMeta {
  name: string;
  description: string;
  safe: boolean;
  args?: Record<string, ToolArg>;
  aliases?: string[];
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Tool source type
 */
export type ToolSource = 'built-in' | 'user' | 'session';

/**
 * Registered tool
 */
export interface RegisteredTool {
  meta: ToolMeta;
  source: ToolSource;
  filePath?: string;
  execute: ToolExecutor;
}

/**
 * Tool executor function
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>;

/**
 * Tool execution context
 */
export interface ToolContext {
  workspaceDir: string;
  projectsDir: string;
  sessionsDir: string;
  toolsDir: string;
  currentSession?: string;
  currentProject?: string;
}

/**
 * Tool file types supported
 */
export type ToolFileType = 'ts' | 'js' | 'sh' | 'skill.md';

/**
 * Parsed skill.md file
 */
export interface SkillDefinition {
  meta: ToolMeta;
  prompt: string;
  examples?: Array<{
    input: string;
    output: string;
  }>;
}
