/**
 * AI Client — pi-ai wrapper
 *
 * Provides utility AI calls for intent parsing, prompt enhancement,
 * and auto-answer. Uses pi-ai's multi-provider API.
 */

import { getModel, complete as piComplete, type Model } from '@mariozechner/pi-ai';

let utilityModel: Model<any> | null = null;

/**
 * Initialize the utility model used for non-agent AI calls.
 */
export function initUtilityModel(provider: string, modelId: string): void {
  utilityModel = getModel(provider as any, modelId as any);
}

/**
 * Get the utility model (or null if not initialized).
 */
export function getUtilityModel(): Model<any> | null {
  return utilityModel;
}

/**
 * Check if the AI client is available.
 */
export function isAIAvailable(): boolean {
  return utilityModel !== null;
}

/**
 * Options for AI completion.
 */
export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Get a completion from the utility model.
 *
 * @param prompt - The user prompt
 * @param options - Optional parameters
 * @returns The assistant's response text
 */
export async function complete(
  prompt: string,
  options: CompletionOptions = {},
): Promise<string> {
  if (!utilityModel) {
    throw new Error('Utility model not initialized. Call initUtilityModel() first.');
  }

  const response = await piComplete(utilityModel, {
    systemPrompt: options.system,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from AI');
  }

  return textBlock.text;
}

/**
 * Estimate token count for a string (rough approximation).
 * ~4 characters per token on average for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to approximately fit within token limit.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}
