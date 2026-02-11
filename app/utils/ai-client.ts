/**
 * AI Client - Anthropic SDK Wrapper
 *
 * Provides a simple interface for calling Claude API.
 * Used for prompt enhancement and auto-answer decisions.
 */

import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;
let configuredModel = 'claude-sonnet-4-5';

/**
 * Set the model used for Milo AI calls (intent parsing, prompt enhancement, auto-answer).
 * This does NOT affect Claude Code sessions.
 */
export function setAIModel(model: string): void {
  configuredModel = model;
}

/**
 * Get the currently configured AI model name.
 */
export function getAIModel(): string {
  return configuredModel;
}

/**
 * Get or create the Anthropic client singleton
 */
export function getAIClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is not set. ' +
          'Please add it to your .env file in the workspace directory.'
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Check if the AI client is available (API key is set)
 */
export function isAIAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Options for AI completion
 */
export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

/**
 * Get a completion from Claude
 *
 * @param prompt - The user prompt
 * @param options - Optional parameters
 * @returns The assistant's response text
 */
export async function complete(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const ai = getAIClient();

  const response = await ai.messages.create({
    model: configuredModel,
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.3,
    stop_sequences: options.stopSequences,
    system: options.system,
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract text from response
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from AI');
  }

  return textBlock.text;
}

/**
 * Estimate token count for a string (rough approximation)
 * ~4 characters per token on average for English text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to approximately fit within token limit
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 3) + '...';
}
