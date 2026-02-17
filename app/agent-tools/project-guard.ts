/**
 * Project Guard
 *
 * Blocks coding tool execution if no specific project has been confirmed
 * for the session. The projectPath must point to a subfolder under PROJECTS/,
 * not the PROJECTS root itself.
 */

import { resolve, relative } from 'path';

/**
 * Assert that projectPath points to a specific project subfolder under PROJECTS/.
 * Throws if projectPath is the PROJECTS root or outside PROJECTS entirely.
 *
 * @param projectPath - The current project path (from tool context or override param)
 * @param workspaceDir - The workspace root directory
 * @param projectsDir - The projects directory name (default: 'PROJECTS')
 */
export function assertProjectConfirmed(
  projectPath: string,
  workspaceDir: string,
  projectsDir = 'PROJECTS',
): void {
  const projectsRoot = resolve(workspaceDir, projectsDir);
  const normalizedPath = resolve(projectPath);
  const rel = relative(projectsRoot, normalizedPath);

  if (!rel || rel === '.' || rel.startsWith('..')) {
    throw new Error(
      'No project has been confirmed for this session. ' +
      'Before using coding tools, you must select a project. ' +
      'Read the project-setup skill at SKILLS/project-setup.md ' +
      'and follow its instructions to confirm a project with the user, ' +
      'then call set_project.',
    );
  }
}
