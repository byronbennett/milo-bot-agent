/**
 * Form definition types and Zod schemas for the declarative form system.
 *
 * The agent sends a FormDefinition to request structured input from the user.
 * The web app renders it inline in the chat; the user submits or cancels;
 * the response flows back to the agent as a FormResponse.
 */

import { z } from 'zod';

// ============================================================================
// Field Name Validation
// ============================================================================

export const fieldNameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ============================================================================
// Zod Schemas
// ============================================================================

const formFieldOptionSchema = z.object({
  label: z.string().max(200),
  value: z.string(),
});

const formFieldBaseSchema = z.object({
  name: z.string().regex(fieldNameRegex),
  label: z.string().max(200),
  description: z.string().max(1000).optional(),
  required: z.boolean(),
});

const textFieldSchema = formFieldBaseSchema.extend({
  type: z.literal('text'),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  value: z.string().optional(),
});

const textareaFieldSchema = formFieldBaseSchema.extend({
  type: z.literal('textarea'),
  placeholder: z.string().optional(),
  rows: z.number().int().min(1).max(20).optional(),
  defaultValue: z.string().optional(),
  value: z.string().optional(),
});

const numberFieldSchema = formFieldBaseSchema.extend({
  type: z.literal('number'),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  defaultValue: z.number().optional(),
  value: z.number().optional(),
});

const checkboxFieldSchema = formFieldBaseSchema.extend({
  type: z.literal('checkbox'),
  defaultValue: z.boolean().optional(),
  value: z.boolean().optional(),
});

const selectFieldSchema = formFieldBaseSchema.extend({
  type: z.literal('select'),
  options: z.array(formFieldOptionSchema).min(1).max(50),
  defaultValue: z.string().optional(),
  value: z.string().optional(),
});

const radioFieldSchema = formFieldBaseSchema.extend({
  type: z.literal('radio'),
  options: z.array(formFieldOptionSchema).min(1).max(50),
  defaultValue: z.string().optional(),
  value: z.string().optional(),
});

export const formFieldSchema = z.discriminatedUnion('type', [
  textFieldSchema,
  textareaFieldSchema,
  numberFieldSchema,
  checkboxFieldSchema,
  selectFieldSchema,
  radioFieldSchema,
]);

export const formStatusSchema = z.enum(['pending', 'submitted', 'cancelled', 'timed_out']);

export const formDefinitionSchema = z.object({
  formId: z.string().uuid(),
  title: z.string().max(200),
  description: z.string().max(1000).optional(),
  critical: z.boolean(),
  status: formStatusSchema,
  fields: z.array(formFieldSchema).min(1).max(20),
  submitLabel: z.string().max(50).optional(),
  cancelLabel: z.string().max(50).optional(),
});

// ============================================================================
// TypeScript Types (inferred from Zod)
// ============================================================================

export type FormFieldOption = z.infer<typeof formFieldOptionSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type FormStatus = z.infer<typeof formStatusSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

// ============================================================================
// Response Types (plain interfaces — not Zod-validated)
// ============================================================================

export interface FormResponseSubmitted {
  formId: string;
  status: 'submitted';
  values: Record<string, string | number | boolean>;
}

export interface FormResponseCancelled {
  formId: string;
  status: 'cancelled';
}

export interface FormResponseTimedOut {
  formId: string;
  status: 'timed_out';
}

export type FormResponse = FormResponseSubmitted | FormResponseCancelled | FormResponseTimedOut;
