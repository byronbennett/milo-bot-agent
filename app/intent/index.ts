/**
 * Intent Parser Module
 *
 * Exports the main parseIntent function and related utilities.
 */

export { parseIntent, parseIntentWithAI, isConfident, describeIntent } from './parser';
export {
  matchOpenSessionPatterns,
  resolveProjectAlias,
  generateSessionName,
  looksLikeTask,
} from './patterns';
export type { PatternMatchResult, AliasMap } from './types';

// Re-export shared types for convenience
export type { IntentType, ParsedIntent } from '../shared';
