/**
 * set_project Tool
 *
 * Confirms or creates a project for the current session.
 * Updates the worker's projectPath and notifies the orchestrator.
 */

import { resolve, join } from 'path';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolContext } from './index.js';

const SetProjectParams = Type.Object({
  projectName: Type.String({
    description: 'Name of the project folder inside PROJECTS/.',
  }),
  isNew: Type.Boolean({
    description: 'Set to true to create a new project. Set to false to use an existing project.',
  }),
});

/**
 * List existing project folder names under the PROJECTS directory.
 */
function listProjects(projectsRoot: string): string[] {
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function createSetProjectTool(ctx: ToolContext, callbacks: {
  onProjectSet: (projectName: string, projectPath: string, isNew: boolean) => void;
}): AgentTool<typeof SetProjectParams> {
  return {
    name: 'set_project',
    label: 'Set Project',
    description:
      'Confirm or create a project for this session. Must be called before using any coding tool (claude_code, gemini_cli, codex_cli). ' +
      'Use isNew=false to select an existing project, or isNew=true to create a new one.',
    parameters: SetProjectParams,
    execute: async (_toolCallId, params) => {
      const projectsRoot = resolve(ctx.workspaceDir, 'PROJECTS');
      const projectPath = join(projectsRoot, params.projectName);
      const existingProjects = listProjects(projectsRoot);

      if (params.isNew) {
        // Creating a new project
        if (existsSync(projectPath)) {
          return {
            content: [{
              type: 'text',
              text: `A project named "${params.projectName}" already exists. ` +
                `To work on the existing project, call set_project with isNew: false. ` +
                `To create a new project, choose a different name.\n\n` +
                `Existing projects: ${existingProjects.join(', ') || '(none)'}`,
            }],
            details: { error: 'project_exists' },
          };
        }

        // Create project directory
        mkdirSync(projectPath, { recursive: true });

        // Initialize git repo
        try {
          execSync('git init', { cwd: projectPath, stdio: 'pipe' });
        } catch (err) {
          // Non-fatal — project still usable without git
        }

        // Copy DEFAULT-CLAUDE.md from templates if it exists
        const templatesDir = resolve(ctx.workspaceDir, 'templates');
        const defaultClaudeMd = join(templatesDir, 'DEFAULT-CLAUDE.md');
        if (existsSync(defaultClaudeMd)) {
          copyFileSync(defaultClaudeMd, join(projectPath, 'CLAUDE.md'));
        }

        callbacks.onProjectSet(params.projectName, projectPath, true);

        return {
          content: [{
            type: 'text',
            text: `New project "${params.projectName}" created and set as active project. ` +
              `Initialized git repo and copied CLAUDE.md template. ` +
              `All tools now operate in: ${projectPath}`,
          }],
          details: { projectName: params.projectName, projectPath, isNew: true },
        };
      } else {
        // Using an existing project
        if (!existsSync(projectPath)) {
          return {
            content: [{
              type: 'text',
              text: `Project "${params.projectName}" not found in PROJECTS/. ` +
                `Available projects: ${existingProjects.join(', ') || '(none)'}`,
            }],
            details: { error: 'project_not_found' },
          };
        }

        callbacks.onProjectSet(params.projectName, projectPath, false);

        return {
          content: [{
            type: 'text',
            text: `Project set to "${params.projectName}" (existing project). ` +
              `All coding tools will now operate in: ${projectPath}`,
          }],
          details: { projectName: params.projectName, projectPath, isNew: false },
        };
      }
    },
  };
}
