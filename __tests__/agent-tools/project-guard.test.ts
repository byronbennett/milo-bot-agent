import { assertProjectConfirmed } from '../../app/agent-tools/project-guard.js';

describe('assertProjectConfirmed', () => {
  const workspaceDir = '/home/user/milo-workspace';

  it('should throw when projectPath is PROJECTS root', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS',
      workspaceDir,
    )).toThrow('No project has been confirmed');
  });

  it('should throw when projectPath is PROJECTS root with trailing slash', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/',
      workspaceDir,
    )).toThrow('No project has been confirmed');
  });

  it('should allow when projectPath is a project subfolder', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/my-app',
      workspaceDir,
    )).not.toThrow();
  });

  it('should allow when project is named PROJECTS', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/PROJECTS',
      workspaceDir,
    )).not.toThrow();
  });

  it('should throw when projectPath is outside PROJECTS', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace',
      workspaceDir,
    )).toThrow('No project has been confirmed');
  });

  it('should allow nested project paths', () => {
    expect(() => assertProjectConfirmed(
      '/home/user/milo-workspace/PROJECTS/my-app/src',
      workspaceDir,
    )).not.toThrow();
  });
});
