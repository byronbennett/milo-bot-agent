# Check Usage Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a `check_usage` agent tool that checks API token usage and costs for Anthropic, OpenAI, and xAI providers.

**Architecture:** A single tool factory function (`createUsageTool`) that checks keychain for admin keys, presents a form for provider/time selection, calls provider APIs via `fetch()`, and returns a formatted text report. Provider-specific logic lives in private helper functions within the same file.

**Tech Stack:** TypeScript, Typebox schemas, pi-agent-core AgentTool interface, OS keychain via `loadToolKey`, native `fetch()` for HTTP.

---

### Task 1: Write the usage tool test file

**Files:**
- Create: `__tests__/agent-tools/usage-tool.test.ts`

**Step 1: Write the failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL — module not found

---

### Task 2: Create the usage tool skeleton

**Files:**
- Create: `app/agent-tools/usage-tool.ts`

**Step 1: Write minimal implementation**

Create `app/agent-tools/usage-tool.ts` with the factory function, Typebox schema, and stub `execute`:

```typescript
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { FormDefinition, FormResponse } from '../shared/form-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageToolDeps {
  loadAdminKey: (provider: string) => Promise<string | null>;
  requestForm: (definition: FormDefinition) => Promise<FormResponse>;
}

interface ProviderInfo {
  id: string;
  label: string;
  keyName: string;
}

const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', keyName: 'anthropic-admin-key' },
  { id: 'openai', label: 'OpenAI', keyName: 'openai-admin-key' },
  { id: 'xai', label: 'xAI', keyName: 'xai-management-key' },
];

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const CheckUsageParams = Type.Object({});

export function createUsageTool(deps: UsageToolDeps): AgentTool<typeof CheckUsageParams> {
  return {
    name: 'check_usage',
    label: 'Check Usage',
    description:
      'Check API token usage and costs for a provider (Anthropic, OpenAI, or xAI). ' +
      'Requires admin/management keys stored in the OS keychain. ' +
      'Call with no parameters — the tool will detect configured providers and present a form.',
    parameters: CheckUsageParams,
    execute: async (_toolCallId) => {
      return {
        content: [{ type: 'text' as const, text: 'Not yet implemented' }],
        details: {},
      };
    },
  };
}
```

**Step 2: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): scaffold check_usage tool with test"
```

---

### Task 3: Implement admin key detection and form

**Files:**
- Modify: `app/agent-tools/usage-tool.ts`
- Modify: `__tests__/agent-tools/usage-tool.test.ts`

**Step 1: Write failing tests for key detection and form flow**

Add to the test file:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL — "Not yet implemented" does not contain "No admin keys configured"

**Step 3: Implement key detection and form logic**

Update the `execute` function in `app/agent-tools/usage-tool.ts`:

```typescript
execute: async (_toolCallId) => {
  // 1. Detect which providers have admin keys
  const available: { provider: ProviderInfo; key: string }[] = [];
  for (const p of PROVIDERS) {
    const key = await deps.loadAdminKey(p.keyName);
    if (key) available.push({ provider: p, key });
  }

  // 2. No keys → return setup instructions
  if (available.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: NO_KEYS_MESSAGE,
      }],
      details: { error: 'no_admin_keys' },
    };
  }

  // 3. Build and send form
  const formId = crypto.randomUUID();
  const formDef: FormDefinition = {
    formId,
    title: 'Check API Usage',
    description: 'Select a provider and time period to view token usage and costs.',
    critical: false,
    status: 'pending',
    fields: [
      {
        name: 'provider',
        type: 'radio' as const,
        label: 'Provider',
        required: true,
        options: available.map((a) => ({ label: a.provider.label, value: a.provider.id })),
        defaultValue: available[0].provider.id,
      },
      {
        name: 'period',
        type: 'select' as const,
        label: 'Time Period',
        required: true,
        options: [
          { label: 'Today', value: 'today' },
          { label: 'Last 7 days', value: '7d' },
          { label: 'Last 30 days', value: '30d' },
          { label: 'Current month', value: 'month' },
        ],
        defaultValue: '7d',
      },
    ],
    submitLabel: 'Check Usage',
  };

  const response = await deps.requestForm(formDef);

  if (response.status !== 'submitted') {
    return {
      content: [{ type: 'text' as const, text: `Usage check ${response.status}.` }],
      details: { status: response.status },
    };
  }

  // 4. Placeholder for API call (next task)
  const providerId = response.values.provider as string;
  const period = response.values.period as string;

  return {
    content: [{ type: 'text' as const, text: `Would fetch ${providerId} usage for ${period}` }],
    details: { provider: providerId, period },
  };
},
```

Also add the `NO_KEYS_MESSAGE` constant at the top of the file:

```typescript
const NO_KEYS_MESSAGE = `No admin keys configured. To check usage, store admin/management keys in the keychain:

**Anthropic:** Get an Admin API key from https://console.anthropic.com/settings/admin-keys
  Then run: milo config set-key usage anthropic-admin-key <your-key>

**OpenAI:** Get an Admin Key from https://platform.openai.com/settings/organization/admin-keys
  Then run: milo config set-key usage openai-admin-key <your-key>

**xAI:** Get a Management Key from https://console.x.ai → Settings → Management Keys
  Then run: milo config set-key usage xai-management-key <your-key>`;
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): implement admin key detection and form flow"
```

---

### Task 4: Implement date range helper

**Files:**
- Modify: `app/agent-tools/usage-tool.ts`
- Modify: `__tests__/agent-tools/usage-tool.test.ts`

**Step 1: Write failing test for date ranges**

```typescript
import { getDateRange } from '../../app/agent-tools/usage-tool.js';

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
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL — `getDateRange` is not exported

**Step 3: Implement getDateRange**

Add to `app/agent-tools/usage-tool.ts` (exported for testing):

```typescript
export function getDateRange(period: string, now = new Date()): { start: Date; end: Date } {
  const end = now;
  let start: Date;

  switch (period) {
    case 'today':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      break;
    case '7d':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7));
      break;
    case '30d':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
      break;
    case 'month':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      break;
    default:
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7));
  }

  return { start, end };
}
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): add getDateRange helper for time period selection"
```

---

### Task 5: Implement Anthropic usage + cost fetch

**Files:**
- Modify: `app/agent-tools/usage-tool.ts`
- Modify: `__tests__/agent-tools/usage-tool.test.ts`

**Step 1: Write failing test for Anthropic fetch**

```typescript
describe('fetchAnthropicUsage', () => {
  it('calls correct URL with admin key and returns formatted report', async () => {
    // Mock global fetch
    const mockResponse = {
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

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      callCount++;
      if (url.includes('usage_report')) return mockResponse;
      if (url.includes('cost_report')) return mockCostResponse;
      return mockResponse;
    }) as any;

    try {
      const { fetchAnthropicUsage } = await import('../../app/agent-tools/usage-tool.js');
      const report = await fetchAnthropicUsage(
        'sk-ant-admin-test',
        new Date('2026-02-12T00:00:00Z'),
        new Date('2026-02-19T00:00:00Z'),
      );
      expect(report).toContain('Anthropic');
      expect(report).toContain('claude-sonnet-4-6');
      expect(report).toContain('100,000');
      expect(report).toContain('50,000');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL — `fetchAnthropicUsage` is not exported

**Step 3: Implement fetchAnthropicUsage**

Add to `app/agent-tools/usage-tool.ts`:

```typescript
// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

interface AnthropicUsageBucket {
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface AnthropicCostBucket {
  description?: string;
  cost_cents: number;
}

export async function fetchAnthropicUsage(
  adminKey: string,
  start: Date,
  end: Date,
): Promise<string> {
  const headers = {
    'x-api-key': adminKey,
    'anthropic-version': '2023-06-01',
  };

  // Fetch usage data grouped by model
  const usageParams = new URLSearchParams({
    starting_at: start.toISOString(),
    ending_at: end.toISOString(),
    bucket_width: '1d',
    'group_by[]': 'model',
  });

  const usageRes = await fetch(
    `https://api.anthropic.com/v1/organizations/usage_report/messages?${usageParams}`,
    { headers },
  );

  if (!usageRes.ok) {
    const body = await usageRes.text();
    if (usageRes.status === 401 || usageRes.status === 403) {
      return `Anthropic auth failed (${usageRes.status}). Your admin key may be invalid or expired.\nGet a new one at: https://console.anthropic.com/settings/admin-keys`;
    }
    return `Anthropic API error ${usageRes.status}: ${body}`;
  }

  const usageData = await usageRes.json();

  // Aggregate by model
  const modelUsage = new Map<string, { input: number; output: number }>();
  for (const bucket of usageData.data ?? []) {
    const model = bucket.model ?? 'unknown';
    const existing = modelUsage.get(model) ?? { input: 0, output: 0 };
    existing.input += bucket.input_tokens ?? 0;
    existing.output += bucket.output_tokens ?? 0;
    modelUsage.set(model, existing);
  }

  // Fetch cost data
  const costParams = new URLSearchParams({
    starting_at: start.toISOString(),
    ending_at: end.toISOString(),
    bucket_width: '1d',
    'group_by[]': 'description',
  });

  let totalCostCents = 0;
  const modelCosts = new Map<string, number>();

  try {
    const costRes = await fetch(
      `https://api.anthropic.com/v1/organizations/cost_report?${costParams}`,
      { headers },
    );

    if (costRes.ok) {
      const costData = await costRes.json();
      for (const bucket of costData.data ?? []) {
        const cents = bucket.cost_cents ?? 0;
        totalCostCents += cents;
        // Description format: "Claude API: claude-sonnet-4-6"
        const desc = bucket.description ?? '';
        const modelMatch = desc.match(/:\s*(.+)/);
        if (modelMatch) {
          const model = modelMatch[1].trim();
          modelCosts.set(model, (modelCosts.get(model) ?? 0) + cents);
        }
      }
    }
  } catch {
    // Cost fetch is best-effort
  }

  // Format report
  return formatReport('Anthropic', start, end, modelUsage, modelCosts, totalCostCents);
}
```

Also add the shared `formatReport` helper and `formatNumber` utility:

```typescript
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatReport(
  provider: string,
  start: Date,
  end: Date,
  modelUsage: Map<string, { input: number; output: number }>,
  modelCosts: Map<string, number>,
  totalCostCents: number,
): string {
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];
  const lines: string[] = [];

  lines.push(`${provider} Usage Report (${startStr} to ${endStr})`);
  lines.push('');

  if (modelUsage.size === 0) {
    lines.push('No usage data found for this period.');
    return lines.join('\n');
  }

  // Header
  const hasCosts = totalCostCents > 0;
  if (hasCosts) {
    lines.push('Model                        | Input Tokens  | Output Tokens | Cost (USD)');
    lines.push('-----------------------------|--------------|--------------|----------');
  } else {
    lines.push('Model                        | Input Tokens  | Output Tokens');
    lines.push('-----------------------------|--------------|-------------');
  }

  let totalInput = 0;
  let totalOutput = 0;

  for (const [model, usage] of modelUsage) {
    totalInput += usage.input;
    totalOutput += usage.output;
    const cost = modelCosts.get(model) ?? 0;
    const modelPadded = model.padEnd(28);
    const inputPadded = formatNumber(usage.input).padStart(13);
    const outputPadded = formatNumber(usage.output).padStart(13);
    if (hasCosts) {
      const costStr = `$${(cost / 100).toFixed(2)}`.padStart(10);
      lines.push(`${modelPadded} | ${inputPadded} | ${outputPadded} | ${costStr}`);
    } else {
      lines.push(`${modelPadded} | ${inputPadded} | ${outputPadded}`);
    }
  }

  lines.push('');
  if (hasCosts) {
    lines.push(`Total: ${formatNumber(totalInput)} input / ${formatNumber(totalOutput)} output tokens | $${(totalCostCents / 100).toFixed(2)}`);
  } else {
    lines.push(`Total: ${formatNumber(totalInput)} input / ${formatNumber(totalOutput)} output tokens`);
  }

  return lines.join('\n');
}
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): implement Anthropic usage and cost API fetch"
```

---

### Task 6: Implement OpenAI usage + cost fetch

**Files:**
- Modify: `app/agent-tools/usage-tool.ts`
- Modify: `__tests__/agent-tools/usage-tool.test.ts`

**Step 1: Write failing test for OpenAI fetch**

```typescript
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
      if (url.includes('/usage/')) return mockUsageResponse;
      if (url.includes('/costs')) return mockCostResponse;
      return mockUsageResponse;
    }) as any;

    try {
      const { fetchOpenAIUsage } = await import('../../app/agent-tools/usage-tool.js');
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
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL — `fetchOpenAIUsage` not exported

**Step 3: Implement fetchOpenAIUsage**

Add to `app/agent-tools/usage-tool.ts`:

```typescript
// ---------------------------------------------------------------------------
// OpenAI API
// ---------------------------------------------------------------------------

export async function fetchOpenAIUsage(
  adminKey: string,
  start: Date,
  end: Date,
): Promise<string> {
  const headers = {
    'Authorization': `Bearer ${adminKey}`,
    'Content-Type': 'application/json',
  };

  const startTime = Math.floor(start.getTime() / 1000);
  const endTime = Math.floor(end.getTime() / 1000);

  // Fetch completions usage grouped by model
  const usageParams = new URLSearchParams({
    start_time: String(startTime),
    end_time: String(endTime),
    bucket_width: '1d',
    'group_by[]': 'model',
  });

  const usageRes = await fetch(
    `https://api.openai.com/v1/organization/usage/completions?${usageParams}`,
    { headers },
  );

  if (!usageRes.ok) {
    const body = await usageRes.text();
    if (usageRes.status === 401 || usageRes.status === 403) {
      return `OpenAI auth failed (${usageRes.status}). Your admin key may be invalid or expired.\nGet a new one at: https://platform.openai.com/settings/organization/admin-keys`;
    }
    return `OpenAI API error ${usageRes.status}: ${body}`;
  }

  const usageData = await usageRes.json();

  // Aggregate by model
  const modelUsage = new Map<string, { input: number; output: number }>();
  for (const bucket of usageData.data ?? []) {
    for (const result of bucket.results ?? []) {
      const model = result.model ?? 'unknown';
      const existing = modelUsage.get(model) ?? { input: 0, output: 0 };
      existing.input += result.input_tokens ?? 0;
      existing.output += result.output_tokens ?? 0;
      modelUsage.set(model, existing);
    }
  }

  // Fetch costs
  const costParams = new URLSearchParams({
    start_time: String(startTime),
    bucket_width: '1d',
  });

  let totalCostCents = 0;
  const modelCosts = new Map<string, number>();

  try {
    const costRes = await fetch(
      `https://api.openai.com/v1/organization/costs?${costParams}`,
      { headers },
    );

    if (costRes.ok) {
      const costData = await costRes.json();
      for (const bucket of costData.data ?? []) {
        for (const result of bucket.results ?? []) {
          const amountCents = Math.round((result.amount?.value ?? 0) * 100);
          totalCostCents += amountCents;
        }
      }
    }
  } catch {
    // Cost fetch is best-effort
  }

  return formatReport('OpenAI', start, end, modelUsage, modelCosts, totalCostCents);
}
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): implement OpenAI usage and cost API fetch"
```

---

### Task 7: Implement xAI balance check

**Files:**
- Modify: `app/agent-tools/usage-tool.ts`
- Modify: `__tests__/agent-tools/usage-tool.test.ts`

Note: xAI's Management API billing endpoints have sparse documentation. The usage endpoint requires a `team_id` which isn't easy to discover. For xAI, we'll implement a simpler approach: check prepaid balance via `GET /v1/billing/teams/{team_id}/prepaid/balance`. We'll store the team_id as a second keychain entry alongside the management key. If the team_id is missing, we'll return instructions.

**Step 1: Write failing test**

```typescript
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
      const { fetchXaiUsage } = await import('../../app/agent-tools/usage-tool.js');
      const report = await fetchXaiUsage('mgmt-key-test', 'team-123');
      expect(report).toContain('xAI');
      expect(report).toContain('balance');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL

**Step 3: Implement fetchXaiUsage**

```typescript
// ---------------------------------------------------------------------------
// xAI API
// ---------------------------------------------------------------------------

export async function fetchXaiUsage(
  managementKey: string,
  teamId: string,
): Promise<string> {
  const headers = {
    'Authorization': `Bearer ${managementKey}`,
    'Content-Type': 'application/json',
  };

  // Fetch prepaid balance
  const balanceRes = await fetch(
    `https://management-api.x.ai/v1/billing/teams/${teamId}/prepaid/balance`,
    { headers },
  );

  if (!balanceRes.ok) {
    const body = await balanceRes.text();
    if (balanceRes.status === 401 || balanceRes.status === 403) {
      return `xAI auth failed (${balanceRes.status}). Your management key may be invalid or expired.\nGet a new one at: https://console.x.ai → Settings → Management Keys`;
    }
    return `xAI API error ${balanceRes.status}: ${body}`;
  }

  const balanceData = await balanceRes.json();
  const balance = balanceData.balance ?? 0;
  const currency = (balanceData.currency ?? 'usd').toUpperCase();

  const lines: string[] = [];
  lines.push('xAI Account Summary');
  lines.push('');
  lines.push(`Prepaid balance: $${(balance / 100).toFixed(2)} ${currency}`);
  lines.push('');
  lines.push('Note: Detailed usage breakdown is available at https://console.x.ai');

  return lines.join('\n');
}
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): implement xAI balance check"
```

---

### Task 8: Wire up execute to call provider functions

**Files:**
- Modify: `app/agent-tools/usage-tool.ts`
- Modify: `__tests__/agent-tools/usage-tool.test.ts`

**Step 1: Write failing integration test**

```typescript
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
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: FAIL — still returns placeholder text "Would fetch anthropic usage..."

**Step 3: Wire up the execute function**

Replace the placeholder in the `execute` function with:

```typescript
// 4. Call the selected provider's API
const providerId = response.values.provider as string;
const period = response.values.period as string;
const { start, end } = getDateRange(period);

const selected = available.find((a) => a.provider.id === providerId);
if (!selected) {
  return {
    content: [{ type: 'text' as const, text: `Unknown provider: ${providerId}` }],
    details: { error: 'unknown_provider' },
  };
}

let report: string;
try {
  switch (providerId) {
    case 'anthropic':
      report = await fetchAnthropicUsage(selected.key, start, end);
      break;
    case 'openai':
      report = await fetchOpenAIUsage(selected.key, start, end);
      break;
    case 'xai': {
      const teamId = await deps.loadAdminKey('xai-team-id');
      if (!teamId) {
        report = 'xAI team ID not configured.\nStore it with: milo config set-key usage xai-team-id <your-team-id>\nFind it at: https://console.x.ai → Settings';
        break;
      }
      report = await fetchXaiUsage(selected.key, teamId);
      break;
    }
    default:
      report = `Provider ${providerId} is not yet supported.`;
  }
} catch (err) {
  report = `Error fetching ${providerId} usage: ${err instanceof Error ? err.message : String(err)}`;
}

return {
  content: [{ type: 'text' as const, text: report }],
  details: { provider: providerId, period },
};
```

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/usage-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/agent-tools/usage-tool.ts __tests__/agent-tools/usage-tool.test.ts
git commit -m "feat(usage): wire up execute to call provider-specific fetch functions"
```

---

### Task 9: Register tool in loadTools

**Files:**
- Modify: `app/agent-tools/index.ts`
- Modify: `__tests__/agent-tools/load-tools.test.ts`

**Step 1: Write failing test**

Add to `__tests__/agent-tools/load-tools.test.ts`:

```typescript
it('full set includes check_usage when requestForm is provided', () => {
  const ctxWithForm = {
    ...ctx,
    requestForm: async () => ({ formId: 'test', status: 'cancelled' as const }),
  };
  const tools = loadTools('full', ctxWithForm);
  const names = tools.map((t) => t.name);
  expect(names).toContain('check_usage');
});

it('minimal set includes check_usage when requestForm is provided', () => {
  const ctxWithForm = {
    ...ctx,
    requestForm: async () => ({ formId: 'test', status: 'cancelled' as const }),
  };
  const tools = loadTools('minimal', ctxWithForm);
  const names = tools.map((t) => t.name);
  expect(names).toContain('check_usage');
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/load-tools.test.ts`
Expected: FAIL — check_usage not found

**Step 3: Register the tool in index.ts**

Modify `app/agent-tools/index.ts`:

1. Add import at top:
```typescript
import { createUsageTool } from './usage-tool.js';
import { loadToolKey } from '../utils/keychain.js';
```

2. In `loadTools()`, after `const formTools = ...`, add:
```typescript
const usageTools = ctx.requestForm
  ? [createUsageTool({ loadAdminKey: (name) => loadToolKey('usage', name), requestForm: ctx.requestForm })]
  : [];
```

3. Add `...usageTools` to the `full`, `minimal`, and default cases in the switch statement, and to the `all` array in the custom array case.

**Step 4: Run tests to verify they pass**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/load-tools.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/agent-tools/`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add app/agent-tools/index.ts __tests__/agent-tools/load-tools.test.ts
git commit -m "feat(usage): register check_usage tool in loadTools for full and minimal sets"
```

---

### Task 10: Run full test suite and verify build

**Files:**
- None (verification only)

**Step 1: Run all tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 2: Type check**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Lint**

Run: `pnpm lint`
Expected: No errors (fix any that arise)

**Step 4: Build**

Run: `pnpm build`
Expected: Clean build

**Step 5: Commit any lint/type fixes if needed**

```bash
git add -A
git commit -m "chore: fix lint/type issues from usage tool"
```
