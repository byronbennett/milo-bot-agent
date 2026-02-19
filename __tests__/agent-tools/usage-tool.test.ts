import { createUsageTool, getDateRange, fetchAnthropicUsage, fetchOpenAIUsage, fetchXaiUsage } from '../../app/agent-tools/usage-tool.js';

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

describe('fetchAnthropicUsage', () => {
  it('calls correct URL with admin key and returns formatted report', async () => {
    const mockUsageResponse = {
      ok: true,
      json: async () => ({
        data: [
          {
            snapshot_at: '2026-02-19T00:00:00Z',
            model: 'claude-sonnet-4-6',
            input_tokens: 100000,
            output_tokens: 50000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
        has_more: false,
      }),
    };
    const mockCostResponse = {
      ok: true,
      json: async () => ({
        data: [
          {
            snapshot_at: '2026-02-19T00:00:00Z',
            description: 'Claude API: claude-sonnet-4-6',
            cost_cents: 150,
          },
        ],
        has_more: false,
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('usage_report')) return mockUsageResponse;
      if (typeof url === 'string' && url.includes('cost_report')) return mockCostResponse;
      return mockUsageResponse;
    }) as any;

    try {
      const report = await fetchAnthropicUsage(
        'sk-ant-admin-test',
        new Date('2026-02-12T00:00:00Z'),
        new Date('2026-02-19T00:00:00Z'),
      );
      expect(report).toContain('Anthropic');
      expect(report).toContain('claude-sonnet-4-6');
      expect(report).toContain('100,000');
      expect(report).toContain('50,000');
      expect(report).toContain('$1.50');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns auth error message on 401', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })) as any;

    try {
      const report = await fetchAnthropicUsage(
        'bad-key',
        new Date('2026-02-12T00:00:00Z'),
        new Date('2026-02-19T00:00:00Z'),
      );
      expect(report).toContain('auth failed');
      expect(report).toContain('console.anthropic.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('fetchOpenAIUsage', () => {
  it('calls correct URL with admin key and returns formatted report', async () => {
    const mockUsageResponse = {
      ok: true,
      json: async () => ({
        data: [
          {
            start_time: 1739836800,
            end_time: 1739923200,
            results: [
              {
                object: 'organization.usage.completions.result',
                input_tokens: 200000,
                output_tokens: 80000,
                num_model_requests: 500,
                model: 'gpt-4o-2025-01-01',
              },
            ],
          },
        ],
      }),
    };
    const mockCostResponse = {
      ok: true,
      json: async () => ({
        data: [
          {
            start_time: 1739836800,
            end_time: 1739923200,
            results: [
              {
                object: 'organization.costs.result',
                amount: { value: 250, currency: 'usd' },
                line_item: 'Completions',
              },
            ],
          },
        ],
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/usage/')) return mockUsageResponse;
      if (typeof url === 'string' && url.includes('/costs')) return mockCostResponse;
      return mockUsageResponse;
    }) as any;

    try {
      const report = await fetchOpenAIUsage(
        'sk-admin-test',
        new Date('2026-02-12T00:00:00Z'),
        new Date('2026-02-19T00:00:00Z'),
      );
      expect(report).toContain('OpenAI');
      expect(report).toContain('gpt-4o');
      expect(report).toContain('200,000');
      expect(report).toContain('80,000');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns auth error message on 403', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    })) as any;

    try {
      const report = await fetchOpenAIUsage(
        'bad-key',
        new Date('2026-02-12T00:00:00Z'),
        new Date('2026-02-19T00:00:00Z'),
      );
      expect(report).toContain('auth failed');
      expect(report).toContain('platform.openai.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('execute end-to-end', () => {
  it('returns Anthropic report when form is submitted', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        data: [
          { model: 'claude-sonnet-4-6', input_tokens: 50000, output_tokens: 20000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ],
        has_more: false,
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => mockResponse) as any;

    try {
      const tool = createUsageTool({
        loadAdminKey: async (name) => (name === 'anthropic-admin-key' ? 'sk-admin-test' : null),
        requestForm: async (def) => ({
          formId: def.formId,
          status: 'submitted' as const,
          values: { provider: 'anthropic', period: '7d' },
        }),
      });

      const result = await tool.execute('call-1', {});
      expect(result.content[0].text).toContain('Anthropic');
      expect(result.content[0].text).toContain('50,000');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns OpenAI report when form is submitted', async () => {
    const mockUsageResponse = {
      ok: true,
      json: async () => ({
        data: [
          {
            start_time: 1739836800,
            end_time: 1739923200,
            results: [
              { model: 'gpt-4o', input_tokens: 100000, output_tokens: 40000, num_model_requests: 200 },
            ],
          },
        ],
      }),
    };
    const mockCostResponse = {
      ok: true,
      json: async () => ({ data: [] }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/costs')) return mockCostResponse;
      return mockUsageResponse;
    }) as any;

    try {
      const tool = createUsageTool({
        loadAdminKey: async (name) => (name === 'openai-admin-key' ? 'sk-admin-test' : null),
        requestForm: async (def) => ({
          formId: def.formId,
          status: 'submitted' as const,
          values: { provider: 'openai', period: '30d' },
        }),
      });

      const result = await tool.execute('call-1', {});
      expect(result.content[0].text).toContain('OpenAI');
      expect(result.content[0].text).toContain('100,000');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns xAI missing team-id message when team-id not configured', async () => {
    const tool = createUsageTool({
      loadAdminKey: async (name) => {
        if (name === 'xai-management-key') return 'mgmt-key-test';
        return null;  // xai-team-id returns null
      },
      requestForm: async (def) => ({
        formId: def.formId,
        status: 'submitted' as const,
        values: { provider: 'xai', period: '7d' },
      }),
    });

    const result = await tool.execute('call-1', {});
    expect(result.content[0].text).toContain('team ID not configured');
  });
});

describe('fetchXaiUsage', () => {
  it('returns balance info when team_id and key are available', async () => {
    const mockBalanceResponse = {
      ok: true,
      json: async () => ({
        balance: 4250,
        currency: 'usd',
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => mockBalanceResponse) as any;

    try {
      const report = await fetchXaiUsage('mgmt-key-test', 'team-123');
      expect(report).toContain('xAI');
      expect(report).toContain('$42.50');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns auth error message on 401', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })) as any;

    try {
      const report = await fetchXaiUsage('bad-key', 'team-123');
      expect(report).toContain('auth failed');
      expect(report).toContain('console.x.ai');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

