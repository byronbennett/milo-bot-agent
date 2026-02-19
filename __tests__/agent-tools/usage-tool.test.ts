import { createUsageTool, getDateRange } from '../../app/agent-tools/usage-tool.js';

describe('createUsageTool', () => {
  it('returns a tool with correct name and label', () => {
    const tool = createUsageTool({
      loadAdminKey: async () => null,
      requestForm: async () => ({ formId: 'test', status: 'cancelled' as const }),
    });
    expect(tool.name).toBe('check_usage');
    expect(tool.label).toBe('Check Usage');
  });
});

describe('execute', () => {
  it('returns setup instructions when no admin keys are configured', async () => {
    const tool = createUsageTool({
      loadAdminKey: async () => null,
      requestForm: async () => ({ formId: 'test', status: 'cancelled' as const }),
    });
    const result = await tool.execute('call-1', {});
    const text = result.content[0].text;
    expect(text).toContain('No admin keys configured');
    expect(text).toContain('Anthropic');
    expect(text).toContain('OpenAI');
  });

  it('sends a form with only configured providers', async () => {
    let capturedForm: any = null;
    const tool = createUsageTool({
      loadAdminKey: async (provider) => (provider === 'anthropic-admin-key' ? 'sk-admin-test' : null),
      requestForm: async (def) => {
        capturedForm = def;
        return { formId: def.formId, status: 'cancelled' as const };
      },
    });
    await tool.execute('call-1', {});
    expect(capturedForm).not.toBeNull();
    const providerField = capturedForm.fields.find((f: any) => f.name === 'provider');
    expect(providerField.options).toHaveLength(1);
    expect(providerField.options[0].value).toBe('anthropic');
  });

  it('includes time period select in the form', async () => {
    let capturedForm: any = null;
    const tool = createUsageTool({
      loadAdminKey: async () => 'sk-test',
      requestForm: async (def) => {
        capturedForm = def;
        return { formId: def.formId, status: 'cancelled' as const };
      },
    });
    await tool.execute('call-1', {});
    const periodField = capturedForm.fields.find((f: any) => f.name === 'period');
    expect(periodField).toBeDefined();
    expect(periodField.type).toBe('select');
    expect(periodField.options.length).toBeGreaterThanOrEqual(4);
  });

  it('returns cancelled message when user cancels form', async () => {
    const tool = createUsageTool({
      loadAdminKey: async () => 'sk-test',
      requestForm: async (def) => ({ formId: def.formId, status: 'cancelled' as const }),
    });
    const result = await tool.execute('call-1', {});
    expect(result.content[0].text).toContain('cancelled');
  });
});

describe('getDateRange', () => {
  const now = new Date('2026-02-19T15:30:00Z');

  it('today returns start of today to now', () => {
    const { start, end } = getDateRange('today', now);
    expect(start.toISOString()).toBe('2026-02-19T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-19T15:30:00.000Z');
  });

  it('7d returns 7 days ago to now', () => {
    const { start, end } = getDateRange('7d', now);
    expect(start.toISOString()).toBe('2026-02-12T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-19T15:30:00.000Z');
  });

  it('30d returns 30 days ago to now', () => {
    const { start, end } = getDateRange('30d', now);
    expect(start.toISOString()).toBe('2026-01-20T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-19T15:30:00.000Z');
  });

  it('month returns start of current month to now', () => {
    const { start, end } = getDateRange('month', now);
    expect(start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-19T15:30:00.000Z');
  });
});

