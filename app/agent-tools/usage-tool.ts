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
