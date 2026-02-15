import { loadTools } from '../../app/agent-tools/index.js';

describe('loadTools', () => {
  const ctx = { projectPath: '/tmp', sendNotification: () => {} };

  it('full set includes core, cli, and ui tools', () => {
    const tools = loadTools('full', ctx);
    const names = tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('claude_code_cli');
    expect(names).toContain('notify_user');
  });

  it('chat set includes only notify_user', () => {
    const tools = loadTools('chat', ctx);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('notify_user');
  });

  it('minimal set includes core + ui but no cli agents', () => {
    const tools = loadTools('minimal', ctx);
    const names = tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('notify_user');
    expect(names).not.toContain('claude_code_cli');
  });

  it('custom array filters by name', () => {
    const tools = loadTools(['bash', 'read_file'], ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['bash', 'read_file']);
  });
});
