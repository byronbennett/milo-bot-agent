import { createUsageTool } from '../../app/agent-tools/usage-tool.js';

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
