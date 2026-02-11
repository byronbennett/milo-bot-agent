/**
 * AI Judge
 *
 * AI-powered auto-answer for questions not matched by rules.
 * Uses Claude to decide whether to answer automatically.
 */

import { complete, isAIAvailable } from '../utils/ai-client';
import { logger } from '../utils/logger';

/**
 * AI judgment result
 */
export interface AIJudgment {
  shouldAnswer: boolean;
  answer?: string;
  confidence: number;
  reasoning?: string;
}

/**
 * Context for AI judgment
 */
export interface JudgmentContext {
  sessionName: string;
  taskDescription?: string;
  projectName?: string;
  previousAnswers?: Array<{ question: string; answer: string }>;
}

/**
 * System prompt for the AI judge
 */
const AI_JUDGE_SYSTEM = `You are an auto-answer decision system for a coding assistant. A question has been asked by Claude Code during a task execution, and you must decide whether to answer it automatically or escalate to the user.

Guidelines for auto-answering:
- YES for: confirmation prompts, safe default choices, standard tool preferences
- NO for: destructive actions, security decisions, ambiguous choices, anything requiring user judgment

Output JSON only:
{"shouldAnswer": true/false, "answer": "the answer if shouldAnswer is true", "confidence": 0.0-1.0, "reasoning": "brief explanation"}

If shouldAnswer is false, still provide a reasoning for why user input is needed.`;

/**
 * Build the judgment prompt
 */
function buildJudgmentPrompt(
  question: string,
  context: JudgmentContext
): string {
  let prompt = `Question from Claude Code: "${question}"`;

  prompt += `\n\nContext:`;
  prompt += `\n- Session: ${context.sessionName}`;

  if (context.taskDescription) {
    prompt += `\n- Task: ${context.taskDescription}`;
  }

  if (context.projectName) {
    prompt += `\n- Project: ${context.projectName}`;
  }

  if (context.previousAnswers && context.previousAnswers.length > 0) {
    prompt += `\n\nPrevious Q&A in this session:`;
    for (const qa of context.previousAnswers.slice(-3)) {
      prompt += `\n- Q: "${qa.question}" -> A: "${qa.answer}"`;
    }
  }

  prompt += `\n\nShould this be auto-answered?`;

  return prompt;
}

/**
 * Get AI judgment on whether to auto-answer a question
 *
 * @param question - The question to judge
 * @param context - Context for the judgment
 * @returns AI judgment
 */
export async function getAIJudgment(
  question: string,
  context: JudgmentContext
): Promise<AIJudgment> {
  if (!isAIAvailable()) {
    logger.debug('AI not available for judgment');
    return {
      shouldAnswer: false,
      confidence: 0,
      reasoning: 'AI not available',
    };
  }

  try {
    const prompt = buildJudgmentPrompt(question, context);

    const response = await complete(prompt, {
      system: AI_JUDGE_SYSTEM,
      maxTokens: 256,
      temperature: 0.1,
    });

    const judgment = JSON.parse(response.trim());

    logger.debug(
      `AI judgment: shouldAnswer=${judgment.shouldAnswer}, confidence=${judgment.confidence}`
    );

    return {
      shouldAnswer: !!judgment.shouldAnswer,
      answer: judgment.answer,
      confidence: judgment.confidence ?? 0.5,
      reasoning: judgment.reasoning,
    };
  } catch (error) {
    logger.warn('AI judgment failed:', error);
    return {
      shouldAnswer: false,
      confidence: 0,
      reasoning: `AI judgment failed: ${error}`,
    };
  }
}

/**
 * Quick check if a question is obviously auto-answerable
 * (without calling AI)
 */
export function isObviouslyAutoAnswerable(question: string): {
  isObvious: boolean;
  answer?: string;
} {
  const q = question.toLowerCase();

  // Obvious "yes" patterns
  const yesPatterns = [
    /proceed\??$/,
    /continue\??$/,
    /is this (?:ok|okay)\??$/,
    /should i (?:proceed|continue)\??$/,
    /ready\??$/,
  ];

  for (const pattern of yesPatterns) {
    if (pattern.test(q)) {
      return { isObvious: true, answer: 'yes' };
    }
  }

  // Obvious "no" patterns for dangerous operations
  const noPatterns = [
    /delete (?:all|everything)/,
    /remove (?:all|everything)/,
    /force push/,
    /reset --hard/,
    /drop (?:table|database)/,
  ];

  for (const pattern of noPatterns) {
    if (pattern.test(q)) {
      return { isObvious: true, answer: 'no' };
    }
  }

  return { isObvious: false };
}
