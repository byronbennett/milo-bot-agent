/**
 * Intent Parser Types
 */

// Re-export core types from shared
export type { IntentType, ParsedIntent } from '../shared';

/**
 * Pattern match result from a single pattern
 */
export interface PatternMatchResult {
  matched: boolean;
  project?: string;
  task?: string;
  confidence: number;
}

/**
 * Alias map for project name resolution
 */
export type AliasMap = Record<string, string>;
