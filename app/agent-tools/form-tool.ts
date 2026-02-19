import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { FormDefinition, FormResponse } from '../shared/form-types.js';

export interface FormToolContext {
  requestForm: (definition: FormDefinition) => Promise<FormResponse>;
}

export function createFormTool(ctx: FormToolContext): AgentTool<any> {
  return {
    name: 'request_user_input',
    label: 'Request User Input',
    description:
      'Send a structured form to the user and wait for their response. ' +
      'Use this when you need specific, structured information rather than free-text conversation. ' +
      'Supported field types: text, textarea, number, checkbox, select, radio. ' +
      'For checkbox fields, required=true means the box must be checked (e.g. terms acceptance).',
    parameters: Type.Object({
      title: Type.String({ description: 'Form title shown to user' }),
      description: Type.Optional(Type.String({ description: 'Explanation of why this input is needed' })),
      critical: Type.Optional(
        Type.Boolean({ description: 'If true, waits indefinitely for response. If false (default), times out after 15 minutes.' })
      ),
      fields: Type.Array(
        Type.Object({
          name: Type.String({ description: 'Machine-readable key (letters, numbers, underscores)' }),
          type: Type.Union([
            Type.Literal('text'),
            Type.Literal('textarea'),
            Type.Literal('number'),
            Type.Literal('checkbox'),
            Type.Literal('select'),
            Type.Literal('radio'),
          ], { description: 'Field type' }),
          label: Type.String({ description: 'Human-readable label' }),
          description: Type.Optional(Type.String({ description: 'Help text below the field' })),
          required: Type.Boolean({ description: 'Whether this field must be filled' }),
          placeholder: Type.Optional(Type.String()),
          defaultValue: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
          options: Type.Optional(
            Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))
          ),
          min: Type.Optional(Type.Number()),
          max: Type.Optional(Type.Number()),
          step: Type.Optional(Type.Number()),
          rows: Type.Optional(Type.Number()),
        }),
        { description: 'Form fields (max 20)' }
      ),
      submitLabel: Type.Optional(Type.String({ description: 'Custom submit button text' })),
      cancelLabel: Type.Optional(Type.String({ description: 'Custom cancel button text' })),
    }),
    execute: async (_toolCallId, args) => {
      const formId = crypto.randomUUID();

      const definition: FormDefinition = {
        formId,
        title: args.title,
        description: args.description,
        critical: args.critical ?? false,
        status: 'pending',
        fields: args.fields,
        submitLabel: args.submitLabel,
        cancelLabel: args.cancelLabel,
      };

      const response = await ctx.requestForm(definition);

      const result = JSON.stringify({
        status: response.status,
        values: response.status === 'submitted' ? response.values : undefined,
        reason:
          response.status === 'cancelled'
            ? 'User cancelled the form'
            : response.status === 'timed_out'
              ? 'User did not respond within 15 minutes'
              : undefined,
      });

      return {
        content: [{ type: 'text' as const, text: result }],
        details: { formId, status: response.status },
      };
    },
  };
}
