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
