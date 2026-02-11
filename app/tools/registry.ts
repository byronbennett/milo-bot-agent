/**
 * Tool Registry
 *
 * Discovers, registers, and manages tools.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { logger } from '../utils/logger';
import type {
  RegisteredTool,
  ToolMeta,
  ToolExecutor,
  ToolSource,
  ToolContext,
  SkillDefinition,
} from './types';

/**
 * Registry of all available tools
 */
const registry = new Map<string, RegisteredTool>();

/**
 * Register a tool
 *
 * @param meta - Tool metadata
 * @param execute - Tool executor function
 * @param source - Tool source (built-in, user, session)
 * @param filePath - Optional file path for user tools
 */
export function registerTool(
  meta: ToolMeta,
  execute: ToolExecutor,
  source: ToolSource = 'user',
  filePath?: string
): void {
  const tool: RegisteredTool = {
    meta,
    source,
    filePath,
    execute,
  };

  registry.set(meta.name, tool);

  // Register aliases
  if (meta.aliases) {
    for (const alias of meta.aliases) {
      registry.set(alias, tool);
    }
  }

  logger.debug(`Registered tool: ${meta.name} (${source})`);
}

/**
 * Get a tool by name
 *
 * @param name - Tool name or alias
 * @returns The registered tool or undefined
 */
export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

/**
 * List all registered tools
 *
 * @param source - Optional filter by source
 * @returns Array of registered tools
 */
export function listTools(source?: ToolSource): RegisteredTool[] {
  const tools = Array.from(registry.values());

  // Filter out duplicates (same tool registered under multiple names)
  const unique = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    unique.set(tool.meta.name, tool);
  }

  const result = Array.from(unique.values());

  if (source) {
    return result.filter((t) => t.source === source);
  }

  return result;
}

/**
 * Check if a tool exists
 *
 * @param name - Tool name
 * @returns True if tool exists
 */
export function hasTool(name: string): boolean {
  return registry.has(name);
}

/**
 * Unregister a tool
 *
 * @param name - Tool name
 * @returns True if tool was removed
 */
export function unregisterTool(name: string): boolean {
  const tool = registry.get(name);
  if (!tool) return false;

  // Remove main entry
  registry.delete(name);

  // Remove aliases
  if (tool.meta.aliases) {
    for (const alias of tool.meta.aliases) {
      registry.delete(alias);
    }
  }

  logger.debug(`Unregistered tool: ${name}`);
  return true;
}

/**
 * Clear all tools (useful for testing)
 */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * Discover tools in a directory
 *
 * @param toolsDir - Path to tools directory
 * @param source - Source type for discovered tools
 * @returns Number of tools discovered
 */
export async function discoverTools(
  toolsDir: string,
  source: ToolSource = 'user'
): Promise<number> {
  if (!existsSync(toolsDir)) {
    logger.debug(`Tools directory not found: ${toolsDir}`);
    return 0;
  }

  let count = 0;
  const files = readdirSync(toolsDir);

  for (const file of files) {
    const filePath = join(toolsDir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      // Recursively discover in subdirectories
      count += await discoverTools(filePath, source);
      continue;
    }

    const ext = extname(file);
    const name = basename(file, ext);

    try {
      if (ext === '.ts' || ext === '.js') {
        // TypeScript/JavaScript tool
        await discoverTsJsTool(filePath, name, source);
        count++;
      } else if (ext === '.sh') {
        // Shell script tool
        discoverShellTool(filePath, name, source);
        count++;
      } else if (file.endsWith('.skill.md')) {
        // Skill markdown file
        const skillName = file.replace('.skill.md', '');
        discoverSkillTool(filePath, skillName, source);
        count++;
      }
    } catch (error) {
      logger.warn(`Failed to discover tool ${file}:`, error);
    }
  }

  logger.info(`Discovered ${count} tools in ${toolsDir}`);
  return count;
}

/**
 * Discover a TypeScript/JavaScript tool
 */
async function discoverTsJsTool(
  filePath: string,
  name: string,
  source: ToolSource
): Promise<void> {
  // Dynamic import would be needed here
  // For now, we'll skip runtime loading and require explicit registration
  logger.debug(`Found TS/JS tool: ${name} at ${filePath}`);

  // Create a placeholder registration
  const meta: ToolMeta = {
    name,
    description: `Tool from ${filePath}`,
    safe: false, // Default to unsafe until loaded
  };

  const execute: ToolExecutor = async () => {
    return {
      success: false,
      error: 'Dynamic tool loading not yet implemented. Register tool explicitly.',
    };
  };

  registerTool(meta, execute, source, filePath);
}

/**
 * Discover a shell script tool
 */
function discoverShellTool(
  filePath: string,
  name: string,
  source: ToolSource
): void {
  logger.debug(`Found shell tool: ${name} at ${filePath}`);

  // Read first line for description comment
  const content = readFileSync(filePath, 'utf-8');
  const firstLine = content.split('\n')[0];
  const description = firstLine.startsWith('#!')
    ? content.split('\n')[1]?.replace(/^#\s*/, '') ?? `Shell script: ${name}`
    : firstLine.replace(/^#\s*/, '');

  const meta: ToolMeta = {
    name,
    description,
    safe: false, // Shell scripts are unsafe by default
  };

  const execute: ToolExecutor = async (args, context) => {
    const { execSync } = await import('child_process');

    try {
      // Pass args as environment variables
      const env = { ...process.env };
      for (const [key, value] of Object.entries(args)) {
        env[`TOOL_ARG_${key.toUpperCase()}`] = String(value);
      }
      env['TOOL_WORKSPACE'] = context.workspaceDir;
      env['TOOL_PROJECTS'] = context.projectsDir;

      const output = execSync(`bash "${filePath}"`, {
        cwd: context.workspaceDir,
        env,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return { success: true, output };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  };

  registerTool(meta, execute, source, filePath);
}

/**
 * Discover a skill.md tool
 */
function discoverSkillTool(
  filePath: string,
  name: string,
  source: ToolSource
): void {
  logger.debug(`Found skill: ${name} at ${filePath}`);

  const content = readFileSync(filePath, 'utf-8');
  const skill = parseSkillMd(content, name);

  const execute: ToolExecutor = async () => {
    // Skills are prompts for Claude Code, not directly executable
    return {
      success: true,
      output: skill.prompt,
      data: { isSkill: true, skill },
    };
  };

  registerTool(skill.meta, execute, source, filePath);
}

/**
 * Parse a skill.md file
 */
function parseSkillMd(content: string, name: string): SkillDefinition {
  const lines = content.split('\n');

  let description = '';
  let safe = true;
  let prompt = '';
  let inPrompt = false;

  for (const line of lines) {
    if (line.startsWith('# ')) {
      // Title line - could extract name from here
      continue;
    }

    if (line.startsWith('## Description')) {
      continue;
    }

    if (line.startsWith('## Prompt')) {
      inPrompt = true;
      continue;
    }

    if (line.startsWith('## ') && inPrompt) {
      inPrompt = false;
      continue;
    }

    if (line.startsWith('safe:')) {
      safe = line.includes('true');
      continue;
    }

    if (inPrompt) {
      prompt += line + '\n';
    } else if (!line.startsWith('#') && line.trim()) {
      description += line.trim() + ' ';
    }
  }

  return {
    meta: {
      name,
      description: description.trim() || `Skill: ${name}`,
      safe,
    },
    prompt: prompt.trim(),
  };
}

/**
 * Get tool count
 */
export function getToolCount(): number {
  // Count unique tools only
  const unique = new Set<string>();
  for (const tool of registry.values()) {
    unique.add(tool.meta.name);
  }
  return unique.size;
}
