/**
 * Intent Parser
 *
 * Analyzes user messages and extracts structured intent data.
 * Uses pattern matching as primary mechanism with optional AI fallback.
 */

import type { PendingMessage, ParsedIntent, AgentConfig } from '../shared';
import {
  matchOpenSessionPatterns,
  resolveProjectAlias,
  generateSessionName,
  looksLikeTask,
} from './patterns';
import { complete, isAIAvailable } from '../utils/ai-client';
import { logger } from '../utils/logger';

/**
 * Parse a pending message into structured intent
 *
 * @param message - The pending message from the user
 * @param config - Agent configuration (for alias resolution)
 * @returns Parsed intent with type, extracted data, and confidence
 */
export function parseIntent(
  message: PendingMessage,
  config: AgentConfig
): ParsedIntent {
  const content = message.content.trim();

  // Case 1: Message has sessionId - it's a send_message to existing session
  if (message.sessionId) {
    logger.verbose('  Intent: message has sessionId, treating as send_message');
    return {
      type: 'send_message',
      sessionName: message.sessionName ?? undefined,
      taskDescription: content,
      confidence: 1.0,
      raw: content,
    };
  }

  // Case 2: Try pattern matching for open_session
  logger.verbose('  Trying pattern matching...');
  const patternResult = matchOpenSessionPatterns(content);

  if (patternResult.matched && patternResult.task) {
    const projectName = resolveProjectAlias(
      patternResult.project,
      config.aliases
    );
    const sessionName = generateSessionName(patternResult.task);

    logger.verbose(`  Pattern matched: open_session (confidence: ${patternResult.confidence})`);
    logger.verbose(`  Project: ${projectName ?? 'none'}, Session: ${sessionName}`);

    return {
      type: 'open_session',
      projectName,
      sessionName,
      taskDescription: patternResult.task,
      confidence: patternResult.confidence,
      raw: content,
    };
  }

  // Case 3: Check if it looks like a task (weak match)
  if (looksLikeTask(content)) {
    const sessionName = generateSessionName(content);
    logger.verbose(`  Weak task match (confidence: 0.3), session: ${sessionName}`);

    return {
      type: 'open_session',
      sessionName,
      taskDescription: content,
      confidence: 0.3, // Low confidence - might need clarification
      raw: content,
    };
  }

  // Case 4: Unknown intent
  logger.verbose('  No pattern matched, intent: unknown');
  return {
    type: 'unknown',
    confidence: 0,
    raw: content,
  };
}

/**
 * Check if an intent has sufficient confidence to act on
 *
 * @param intent - The parsed intent
 * @param threshold - Minimum confidence threshold (default 0.5)
 */
export function isConfident(
  intent: ParsedIntent,
  threshold = 0.5
): boolean {
  return intent.confidence >= threshold;
}

/**
 * Get a human-readable description of the parsed intent
 */
export function describeIntent(intent: ParsedIntent): string {
  switch (intent.type) {
    case 'open_session':
      if (intent.projectName) {
        return `Start session "${intent.sessionName}" in project "${intent.projectName}"`;
      }
      return `Start session "${intent.sessionName}"`;

    case 'send_message':
      if (intent.sessionName) {
        return `Send message to session "${intent.sessionName}"`;
      }
      return 'Send message to active session';

    case 'unknown':
      return 'Unknown intent - could not parse message';

    default:
      return `Intent: ${intent.type}`;
  }
}

/**
 * System prompt for AI-based intent parsing
 */
const INTENT_PARSER_SYSTEM = `You are an intent parser for a coding assistant. Analyze user messages and extract structured intent.

Output JSON only, no explanation. Format:
{"type": "open_session" | "send_message" | "unknown", "project": "name or null", "task": "description or null"}

Rules:
- "open_session": User wants to start a new coding task
- "send_message": User is responding to an ongoing session (rare without context)
- "unknown": Cannot determine intent (questions, greetings, unclear requests)
- Extract project name if mentioned (e.g., "in my-app", "for the frontend")
- Extract task description (what they want done)

Examples:
"fix the bug in the login form" → {"type": "open_session", "project": null, "task": "fix the bug in the login form"}
"work on my-api to add authentication" → {"type": "open_session", "project": "my-api", "task": "add authentication"}
"hello" → {"type": "unknown", "project": null, "task": null}
"what time is it" → {"type": "unknown", "project": null, "task": null}`;

/**
 * Parse intent with AI fallback for ambiguous inputs
 *
 * Uses pattern matching first, falls back to AI only when:
 * - Pattern matching fails (unknown intent)
 * - Confidence is below threshold
 *
 * @param message - The pending message from the user
 * @param config - Agent configuration
 * @param options - Parsing options
 */
export async function parseIntentWithAI(
  message: PendingMessage,
  config: AgentConfig,
  options: { confidenceThreshold?: number; skipAI?: boolean } = {}
): Promise<ParsedIntent> {
  const { confidenceThreshold = 0.9, skipAI = false } = options;

  // Try pattern matching first
  const patternIntent = parseIntent(message, config);

  // If confident enough or AI disabled, return pattern result
  if (patternIntent.confidence >= confidenceThreshold || skipAI) {
    logger.verbose(`  Pattern result accepted (confidence: ${patternIntent.confidence} >= threshold: ${confidenceThreshold})`);
    return patternIntent;
  }

  // If pattern failed or low confidence, try AI fallback
  if (isAIAvailable()) {
    try {
      logger.verbose('  Pattern matching insufficient, falling back to AI...');
      const aiIntent = await parseWithAI(message.content, config);
      if (aiIntent.type !== 'unknown') {
        logger.verbose(`  AI parsed intent: ${aiIntent.type} (confidence: ${aiIntent.confidence})`);
        return aiIntent;
      }
      logger.verbose('  AI also returned unknown intent');
    } catch (error) {
      logger.warn('AI intent parsing failed:', error);
    }
  } else {
    logger.verbose('  AI not available for fallback parsing');
  }

  // Return pattern result as fallback
  return patternIntent;
}

/**
 * Parse intent using AI (Claude API)
 */
async function parseWithAI(
  content: string,
  config: AgentConfig
): Promise<ParsedIntent> {
  const userPrompt = `Parse this message: "${content}"`;
  logger.verbose('  AI prompt (system):', INTENT_PARSER_SYSTEM);
  logger.verbose('  AI prompt (user):', userPrompt);

  const response = await complete(
    userPrompt,
    {
      system: INTENT_PARSER_SYSTEM,
      maxTokens: 128,
      temperature: 0,
    }
  );

  logger.verbose('  AI raw response:', response);

  try {
    // Strip markdown code fences if present (e.g. ```json ... ```)
    const cleaned = response.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    if (parsed.type === 'open_session' && parsed.task) {
      const projectName = resolveProjectAlias(parsed.project, config.aliases);
      const sessionName = generateSessionName(parsed.task);

      return {
        type: 'open_session',
        projectName: projectName ?? undefined,
        sessionName,
        taskDescription: parsed.task,
        confidence: 0.8, // AI-derived intent
        raw: content,
      };
    }

    if (parsed.type === 'send_message') {
      return {
        type: 'send_message',
        taskDescription: parsed.task ?? content,
        confidence: 0.8,
        raw: content,
      };
    }

    return {
      type: 'unknown',
      confidence: 0,
      raw: content,
    };
  } catch {
    logger.warn('Failed to parse AI response:', response);
    return {
      type: 'unknown',
      confidence: 0,
      raw: content,
    };
  }
}
