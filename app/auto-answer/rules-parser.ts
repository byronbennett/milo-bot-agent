/**
 * Rules Parser
 *
 * Parses RULES.md files for auto-answer rules.
 *
 * Rule format in RULES.md:
 * ```
 * # Auto-Answer Rules
 *
 * ## Always Yes
 * - "proceed with" -> "yes"
 * - "continue?" -> "yes"
 *
 * ## Always No
 * - "delete all" -> "no"
 *
 * ## Custom Answers
 * - "which test framework" -> "jest"
 * - "formatting style" -> "prettier"
 * ```
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';

/**
 * A single auto-answer rule
 */
export interface AutoAnswerRule {
  pattern: string | RegExp;
  answer: string;
  source: 'global' | 'session';
  priority: number;
}

/**
 * Parsed rules file
 */
export interface ParsedRules {
  rules: AutoAnswerRule[];
  source: string;
}

/**
 * Parse a RULES.md file
 *
 * @param filePath - Path to the RULES.md file
 * @param source - Source identifier ('global' or 'session')
 * @returns Parsed rules
 */
export function parseRulesFile(
  filePath: string,
  source: 'global' | 'session' = 'global'
): ParsedRules {
  const rules: AutoAnswerRule[] = [];

  if (!existsSync(filePath)) {
    logger.debug(`Rules file not found: ${filePath}`);
    return { rules, source: filePath };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let currentPriority = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and headers
      if (!trimmed || trimmed.startsWith('#')) {
        // Headers can adjust priority
        if (trimmed.startsWith('## Always')) {
          currentPriority = 10; // High priority for explicit always rules
        } else if (trimmed.startsWith('## Custom')) {
          currentPriority = 5; // Medium priority for custom rules
        } else if (trimmed.startsWith('## Default')) {
          currentPriority = 1; // Low priority for defaults
        }
        continue;
      }

      // Parse rule line: - "pattern" -> "answer"
      const ruleMatch = trimmed.match(
        /^-\s*["'](.+?)["']\s*->\s*["'](.+?)["']$/
      );

      if (ruleMatch) {
        const [, pattern, answer] = ruleMatch;
        rules.push({
          pattern: pattern.toLowerCase(),
          answer,
          source,
          priority: currentPriority,
        });
        continue;
      }

      // Parse regex rule: - /pattern/i -> "answer"
      const regexMatch = trimmed.match(
        /^-\s*\/(.+?)\/([gimsuy]*)\s*->\s*["'](.+?)["']$/
      );

      if (regexMatch) {
        const [, pattern, flags, answer] = regexMatch;
        try {
          rules.push({
            pattern: new RegExp(pattern, flags),
            answer,
            source,
            priority: currentPriority,
          });
        } catch (e) {
          logger.warn(`Invalid regex in rules file: ${pattern}`, e);
        }
      }
    }

    logger.debug(`Parsed ${rules.length} rules from ${filePath}`);
    return { rules, source: filePath };
  } catch (error) {
    logger.error(`Failed to parse rules file ${filePath}:`, error);
    return { rules, source: filePath };
  }
}

/**
 * Load global RULES.md from workspace
 *
 * @param workspaceDir - Path to workspace directory
 * @returns Parsed rules
 */
export function loadGlobalRules(workspaceDir: string): ParsedRules {
  const rulesPath = join(workspaceDir, 'RULES.md');
  return parseRulesFile(rulesPath, 'global');
}

/**
 * Load session-specific rules from session file
 *
 * @param sessionFilePath - Path to the session file
 * @returns Parsed rules
 */
export function loadSessionRules(sessionFilePath: string): ParsedRules {
  const rules: AutoAnswerRule[] = [];

  if (!existsSync(sessionFilePath)) {
    return { rules, source: sessionFilePath };
  }

  try {
    const content = readFileSync(sessionFilePath, 'utf-8');

    // Find the auto-answer rules section
    const rulesSection = content.match(
      /## Auto-answer rules for session:\n([\s\S]*?)(?=\n##|$)/
    );

    if (!rulesSection) {
      return { rules, source: sessionFilePath };
    }

    const rulesText = rulesSection[1];
    const lines = rulesText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Parse rule line: - "pattern" -> "answer"
      const ruleMatch = trimmed.match(
        /^-\s*["'](.+?)["']\s*->\s*["'](.+?)["']$/
      );

      if (ruleMatch) {
        const [, pattern, answer] = ruleMatch;
        rules.push({
          pattern: pattern.toLowerCase(),
          answer,
          source: 'session',
          priority: 20, // Session rules have highest priority
        });
      }
    }

    logger.debug(`Parsed ${rules.length} session rules`);
    return { rules, source: sessionFilePath };
  } catch (error) {
    logger.error('Failed to parse session rules:', error);
    return { rules, source: sessionFilePath };
  }
}

/**
 * Merge multiple rule sets, sorted by priority
 *
 * @param ruleSets - Array of parsed rules
 * @returns Merged and sorted rules
 */
export function mergeRules(...ruleSets: ParsedRules[]): AutoAnswerRule[] {
  const allRules = ruleSets.flatMap((rs) => rs.rules);

  // Sort by priority (highest first)
  return allRules.sort((a, b) => b.priority - a.priority);
}
