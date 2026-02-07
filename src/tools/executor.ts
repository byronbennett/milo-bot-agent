/**
 * Tool Executor
 *
 * Executes tools with safety checks and result handling.
 */

import { logger } from '../utils/logger';
import { getTool, hasTool } from './registry';
import type { ToolResult, ToolContext, RegisteredTool } from './types';

/**
 * Options for tool execution
 */
export interface ExecuteToolOptions {
  /** Skip confirmation for unsafe tools */
  skipConfirmation?: boolean;
  /** Callback to request user confirmation */
  confirmationCallback?: (tool: RegisteredTool) => Promise<boolean>;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Execute a tool by name
 *
 * @param toolName - Name of the tool to execute
 * @param args - Arguments to pass to the tool
 * @param context - Execution context
 * @param options - Execution options
 * @returns Tool result
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
  options: ExecuteToolOptions = {}
): Promise<ToolResult> {
  const { skipConfirmation = false, confirmationCallback, timeout } = options;

  // Check if tool exists
  if (!hasTool(toolName)) {
    logger.warn(`Tool not found: ${toolName}`);
    return {
      success: false,
      error: `Tool not found: ${toolName}`,
    };
  }

  const tool = getTool(toolName)!;

  logger.info(`Executing tool: ${toolName}`);
  logger.debug(`Tool args:`, args);

  // Safety check
  if (!tool.meta.safe && !skipConfirmation) {
    if (confirmationCallback) {
      const confirmed = await confirmationCallback(tool);
      if (!confirmed) {
        logger.info(`Tool execution cancelled by user: ${toolName}`);
        return {
          success: false,
          error: 'Execution cancelled by user',
        };
      }
    } else {
      logger.warn(
        `Unsafe tool ${toolName} requires confirmation but no callback provided`
      );
      return {
        success: false,
        error: 'Unsafe tool requires confirmation',
      };
    }
  }

  // Validate required arguments
  if (tool.meta.args) {
    const validationError = validateArgs(args, tool.meta.args);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }
  }

  // Execute with optional timeout
  try {
    if (timeout) {
      return await executeWithTimeout(tool, args, context, timeout);
    }

    const result = await tool.execute(args, context);
    logger.debug(`Tool ${toolName} result:`, result);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Tool ${toolName} failed:`, errorMessage);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Execute tool with timeout
 */
async function executeWithTimeout(
  tool: RegisteredTool,
  args: Record<string, unknown>,
  context: ToolContext,
  timeout: number
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        success: false,
        error: `Tool execution timed out after ${timeout}ms`,
      });
    }, timeout);

    tool
      .execute(args, context)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

/**
 * Validate tool arguments
 */
function validateArgs(
  args: Record<string, unknown>,
  argDefs: Record<string, { type: string; required?: boolean; default?: unknown }>
): string | null {
  for (const [name, def] of Object.entries(argDefs)) {
    const value = args[name] ?? def.default;

    // Check required
    if (def.required && value === undefined) {
      return `Missing required argument: ${name}`;
    }

    // Type check (if value is provided)
    if (value !== undefined) {
      const actualType = typeof value;
      if (actualType !== def.type) {
        return `Argument ${name} must be ${def.type}, got ${actualType}`;
      }
    }
  }

  return null;
}

/**
 * Execute multiple tools in sequence
 *
 * @param tools - Array of tool executions
 * @param context - Execution context
 * @param options - Execution options
 * @returns Array of results
 */
export async function executeToolSequence(
  tools: Array<{ name: string; args: Record<string, unknown> }>,
  context: ToolContext,
  options: ExecuteToolOptions = {}
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const { name, args } of tools) {
    const result = await executeTool(name, args, context, options);
    results.push(result);

    // Stop on failure
    if (!result.success) {
      break;
    }
  }

  return results;
}

/**
 * Check if a tool is safe to execute
 */
export function isToolSafe(toolName: string): boolean {
  const tool = getTool(toolName);
  return tool?.meta.safe ?? false;
}

/**
 * Get tool description
 */
export function getToolDescription(toolName: string): string | null {
  const tool = getTool(toolName);
  return tool?.meta.description ?? null;
}
