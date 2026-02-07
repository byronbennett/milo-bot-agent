/**
 * Create Project Tool
 *
 * Creates a new project with optional template.
 */

import { join } from 'path';
import { registerTool } from '../registry';
import {
  createDirectory,
  exists,
  initRepo,
  commit,
  createFromTemplate,
  createDefaultProject,
} from '../../files';
import { logger } from '../../utils/logger';
import type { ToolMeta, ToolResult, ToolContext } from '../types';

const meta: ToolMeta = {
  name: 'create-project',
  description: 'Create a new project folder with optional template and git init',
  safe: true,
  aliases: ['new-project', 'init-project'],
  args: {
    name: {
      type: 'string',
      description: 'Project name',
      required: true,
    },
    template: {
      type: 'string',
      description: 'Template to use (optional)',
      required: false,
    },
    description: {
      type: 'string',
      description: 'Project description',
      required: false,
    },
    initGit: {
      type: 'boolean',
      description: 'Initialize git repository',
      default: true,
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const name = args.name as string;
  const template = args.template as string | undefined;
  const description = args.description as string | undefined;
  const initGit = args.initGit !== false;

  const projectPath = join(context.projectsDir, name);

  logger.info(`Creating project: ${name}`);

  // Check if project already exists
  if (exists(projectPath)) {
    return {
      success: false,
      error: `Project '${name}' already exists at ${projectPath}`,
    };
  }

  // Create project directory
  if (!createDirectory(projectPath)) {
    return {
      success: false,
      error: 'Failed to create project directory',
    };
  }

  // Apply template or default
  const templateVars = { projectName: name, description };

  if (template) {
    const success = createFromTemplate(
      context.toolsDir,
      template,
      projectPath,
      templateVars
    );
    if (!success) {
      return {
        success: false,
        error: `Failed to apply template: ${template}`,
      };
    }
  } else {
    const success = createDefaultProject(projectPath, templateVars);
    if (!success) {
      return {
        success: false,
        error: 'Failed to create default project structure',
      };
    }
  }

  // Initialize git if requested
  if (initGit) {
    const gitSuccess = initRepo(projectPath);
    if (gitSuccess) {
      commit(projectPath, 'Initial commit', { addAll: true });
    }
  }

  return {
    success: true,
    output: `Created project '${name}' at ${projectPath}`,
    data: { projectPath, template: template ?? 'default' },
  };
}

// Register the tool
registerTool(meta, execute, 'built-in');

export { meta, execute };
