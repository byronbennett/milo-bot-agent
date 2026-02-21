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
 * If confirmedPaths is provided, also validates the path is under one of them.
 *
 * @param projectPath - The current project path (from tool context or override param)
 * @param workspaceDir - The workspace root directory
 * @param projectsDir - The projects directory name (default: 'PROJECTS')
 * @param confirmedPaths - Optional list of confirmed project paths to validate against
 */
export function assertProjectConfirmed(
  projectPath: string,
  workspaceDir: string,
  projectsDir = 'PROJECTS',
  confirmedPaths?: string[],
): void {
  const projectsRoot = resolve(workspaceDir, projectsDir);
  const normalizedPath = resolve(projectPath);
  const rel = relative(projectsRoot, normalizedPath);

  // Must be under PROJECTS/ and not the root itself
  if (!rel || rel === '.' || rel.startsWith('..')) {
    throw new Error(
      'No project has been confirmed for this session. ' +
      'Before using coding tools, you must select a project. ' +
      'Read the project-setup skill at SKILLS/project-setup.md ' +
      'and follow its instructions to confirm a project with the user, ' +
      'then call set_project.',
    );
  }

  // If confirmedPaths provided, validate against them
  if (confirmedPaths && confirmedPaths.length > 0) {
    const isAllowed = confirmedPaths.some((cp) => {
      const normalizedConfirmed = resolve(cp);
      return normalizedPath === normalizedConfirmed || normalizedPath.startsWith(normalizedConfirmed + '/');
    });
    if (!isAllowed) {
      throw new Error(
        'No project has been confirmed for this session. ' +
        'Before using coding tools, you must select a project. ' +
        'Read the project-setup skill at SKILLS/project-setup.md ' +
        'and follow its instructions to confirm a project with the user, ' +
        'then call set_project.',
      );
    }
  }
}
