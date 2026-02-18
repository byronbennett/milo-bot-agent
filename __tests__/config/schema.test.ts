import { agentConfigSchema } from '../../app/config/schema.js';

describe('Config Schema', () => {
  it('accepts ai.agent and ai.utility with defaults', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
    });
    expect(config.ai.agent.provider).toBe('anthropic');
    expect(config.ai.agent.model).toBe('claude-sonnet-4-6-20250514');
    expect(config.ai.utility.provider).toBe('anthropic');
    expect(config.ai.utility.model).toBe('claude-haiku-4-5-20251001');
  });

  it('accepts custom provider and model', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
      ai: {
        agent: { provider: 'openai', model: 'gpt-4o' },
        utility: { provider: 'google', model: 'gemini-2.5-flash' },
      },
    });
    expect(config.ai.agent.provider).toBe('openai');
    expect(config.ai.utility.provider).toBe('google');
  });

  it('preserves legacy ai.model field', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
      ai: { model: 'claude-sonnet-4-6' },
    });
    expect(config.ai.model).toBe('claude-sonnet-4-6');
  });

  it('accepts update.restartCommand config', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
      update: { restartCommand: 'pm2 restart milo' },
    });
    expect(config.update.restartCommand).toBe('pm2 restart milo');
  });

  it('defaults update config to empty', () => {
    const config = agentConfigSchema.parse({
      agentName: 'test',
      workspace: { baseDir: '/tmp' },
    });
    expect(config.update.restartCommand).toBeUndefined();
  });
});
