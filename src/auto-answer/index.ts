/**
 * Auto-Answer System
 *
 * Automatically answers questions from Claude Code based on:
 * 1. Session-specific rules (highest priority)
 * 2. Global RULES.md rules
 * 3. AI judgment (fallback)
 */

import { logger } from '../utils/logger';
import {
  parseRulesFile,
  loadGlobalRules,
  loadSessionRules,
  mergeRules,
  type AutoAnswerRule,
} from './rules-parser';
import {
  getAIJudgment,
  isObviouslyAutoAnswerable,
  type JudgmentContext,
} from './ai-judge';

export {
  parseRulesFile,
  loadGlobalRules,
  loadSessionRules,
  mergeRules,
  type AutoAnswerRule,
} from './rules-parser';

export {
  getAIJudgment,
  isObviouslyAutoAnswerable,
  type AIJudgment,
  type JudgmentContext,
} from './ai-judge';

/**
 * Result of auto-answer check
 */
export interface AutoAnswerResult {
  shouldAnswer: boolean;
  answer?: string;
  source: 'session_rule' | 'global_rule' | 'ai' | 'obvious' | 'none';
  confidence: number;
  matchedRule?: string;
}

/**
 * Options for auto-answer check
 */
export interface AutoAnswerOptions {
  workspaceDir: string;
  sessionFilePath?: string;
  context?: JudgmentContext;
  useAI?: boolean;
  minConfidence?: number;
}

/**
 * Check if a question should be auto-answered
 *
 * @param question - The question from Claude Code
 * @param options - Auto-answer options
 * @returns Auto-answer result
 */
export async function shouldAutoAnswer(
  question: string,
  options: AutoAnswerOptions
): Promise<AutoAnswerResult> {
  const {
    workspaceDir,
    sessionFilePath,
    context,
    useAI = true,
    minConfidence = 0.7,
  } = options;

  const normalizedQuestion = question.toLowerCase().trim();

  logger.debug(`Checking auto-answer for: "${question.slice(0, 50)}..."`);

  // Step 1: Check obvious patterns (no rules needed)
  const obvious = isObviouslyAutoAnswerable(question);
  if (obvious.isObvious) {
    logger.debug(`Obvious auto-answer: ${obvious.answer}`);
    return {
      shouldAnswer: true,
      answer: obvious.answer,
      source: 'obvious',
      confidence: 1.0,
    };
  }

  // Step 2: Load and merge rules
  const globalRules = loadGlobalRules(workspaceDir);
  const sessionRules = sessionFilePath
    ? loadSessionRules(sessionFilePath)
    : { rules: [], source: '' };

  const allRules = mergeRules(sessionRules, globalRules);

  // Step 3: Check rules (session rules first due to sorting)
  for (const rule of allRules) {
    const matched = matchRule(normalizedQuestion, rule);
    if (matched) {
      logger.debug(
        `Rule matched: "${rule.pattern}" -> "${rule.answer}" (source: ${rule.source})`
      );
      return {
        shouldAnswer: true,
        answer: rule.answer,
        source: rule.source === 'session' ? 'session_rule' : 'global_rule',
        confidence: 0.9,
        matchedRule: String(rule.pattern),
      };
    }
  }

  // Step 4: AI fallback (if enabled)
  if (useAI && context) {
    const judgment = await getAIJudgment(question, context);

    if (judgment.shouldAnswer && judgment.confidence >= minConfidence) {
      logger.debug(
        `AI auto-answer: "${judgment.answer}" (confidence: ${judgment.confidence})`
      );
      return {
        shouldAnswer: true,
        answer: judgment.answer,
        source: 'ai',
        confidence: judgment.confidence,
      };
    }

    // AI says don't auto-answer
    if (!judgment.shouldAnswer) {
      logger.debug(`AI declined auto-answer: ${judgment.reasoning}`);
    }
  }

  // No auto-answer
  logger.debug('No auto-answer found, escalating to user');
  return {
    shouldAnswer: false,
    source: 'none',
    confidence: 0,
  };
}

/**
 * Get auto-answer for a question (convenience function)
 *
 * @param question - The question from Claude Code
 * @param options - Auto-answer options
 * @returns The answer or null if should not auto-answer
 */
export async function getAutoAnswer(
  question: string,
  options: AutoAnswerOptions
): Promise<string | null> {
  const result = await shouldAutoAnswer(question, options);
  return result.shouldAnswer ? (result.answer ?? null) : null;
}

/**
 * Check if a question matches a rule
 */
function matchRule(question: string, rule: AutoAnswerRule): boolean {
  if (typeof rule.pattern === 'string') {
    return question.includes(rule.pattern);
  }

  // RegExp pattern
  return rule.pattern.test(question);
}
