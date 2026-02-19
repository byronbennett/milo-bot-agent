import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { FormDefinition, FormResponse } from '../shared/form-types.js';
import { randomUUID } from 'crypto';

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

const NO_KEYS_MESSAGE = `No admin keys configured. To check usage, store admin/management keys in the keychain:

**Anthropic:** Get an Admin API key from https://console.anthropic.com/settings/admin-keys
  Then run: milo config set-key usage anthropic-admin-key <your-key>

**OpenAI:** Get an Admin Key from https://platform.openai.com/settings/organization/admin-keys
  Then run: milo config set-key usage openai-admin-key <your-key>

**xAI:** Get a Management Key from https://console.x.ai → Settings → Management Keys
  Then run: milo config set-key usage xai-management-key <your-key>`;

// ---------------------------------------------------------------------------
// Date range helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Report formatting helpers (private)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Anthropic usage + cost fetch
// ---------------------------------------------------------------------------

export async function fetchAnthropicUsage(
  adminKey: string,
  start: Date,
  end: Date,
): Promise<string> {
  const headers: Record<string, string> = {
    'x-api-key': adminKey,
    'anthropic-version': '2023-06-01',
  };

  // Fetch usage data grouped by model
  const usageParams = new URLSearchParams({
    starting_at: start.toISOString(),
    ending_at: end.toISOString(),
    bucket_width: '1d',
  });
  usageParams.append('group_by[]', 'model');

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
  });
  costParams.append('group_by[]', 'description');

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

  return formatReport('Anthropic', start, end, modelUsage, modelCosts, totalCostCents);
}

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
      // Check which providers have admin keys configured
      const available: { provider: ProviderInfo; key: string }[] = [];
      for (const p of PROVIDERS) {
        const key = await deps.loadAdminKey(p.keyName);
        if (key) {
          available.push({ provider: p, key });
        }
      }

      // No keys configured — return setup instructions
      if (available.length === 0) {
        return {
          content: [{ type: 'text' as const, text: NO_KEYS_MESSAGE }],
          details: {},
        };
      }

      // Build and send the form
      const formId = randomUUID();
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

      // Handle cancelled or timed-out form
      if (response.status === 'cancelled') {
        return {
          content: [{ type: 'text' as const, text: 'Usage check cancelled.' }],
          details: {},
        };
      }

      if (response.status === 'timed_out') {
        return {
          content: [{ type: 'text' as const, text: 'Usage check timed out.' }],
          details: {},
        };
      }

      // Form submitted — placeholder for API call (will be wired up in a later task)
      return {
        content: [{ type: 'text' as const, text: `Usage check submitted for provider: ${response.values.provider}, period: ${response.values.period}. API integration coming soon.` }],
        details: {},
      };
    },
  };
}
