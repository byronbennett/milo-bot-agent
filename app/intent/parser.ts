/**
 * Intent Parser
 *
 * Analyzes user messages and extracts structured intent data.
 * Uses pattern matching as primary mechanism with optional AI fallback.
 */

import type { PendingMessage, ParsedIntent, AgentConfig } from '../shared';
import {
  matchOpenSessionPatterns,
  matchGreetingPatterns,
  resolveProjectAlias,
  generateSessionName,
  looksLikeTask,
} from './patterns';
import { complete, isAIAvailable } from '../utils/ai-client';
import { logger } from '../utils/logger';
import { listTools } from '../tools';

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

  // Case 4: Check for greetings (low confidence so AI can generate a proper response)
  if (matchGreetingPatterns(content)) {
    logger.verbose('  Greeting pattern matched (confidence: 0.3)');
    return {
      type: 'greeting',
      confidence: 0.3,
      raw: content,
    };
  }

  // Case 5: Unknown intent
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

    case 'question':
      return 'Question - answering directly';

    case 'greeting':
      return 'Greeting - responding with hello';

    case 'unknown':
      return 'Unknown intent - could not parse message';

    default:
      return `Intent: ${intent.type}`;
  }
}

/**
 * Build the system prompt for AI-based intent parsing.
 * Dynamically includes available tools/skills.
 */
function buildSystemPrompt(): string {
  // Build tools/skills section
  const tools = listTools();
  let capabilitiesSection = '';
  if (tools.length > 0) {
    const toolLines = tools.map((t) => `  - ${t.meta.name}: ${t.meta.description}`).join('\n');
    capabilitiesSection = `\nCustom tools available:\n${toolLines}\n`;
  }

  return `You are an intent parser for MiloBot — a general-purpose AI agent that can answer questions, manage tasks, and coordinate complex work through terminal sessions powered by Claude Code.

Output JSON only, no explanation. Schema:
{"type": "open_session" | "send_message" | "question" | "greeting" | "unknown", "project": "name or null", "task": "description or null", "answer": "response or null"}

Intent definitions:
- "open_session": Any task requiring sustained work — coding, research, file operations, web searches, automation, data processing, writing, analysis. A Claude Code session will be spawned to handle it. Set "task" to a clear description.
- "question": Quick questions answerable from general knowledge — facts, explanations, opinions, capability inquiries, conversational replies like "thanks" or "ok". Provide a concise answer in "answer".
- "greeting": Hello/hi/hey. Respond warmly in "answer", briefly mention what you can help with (not just coding).
- "send_message": Reply to an ongoing session (rare without context).
- "unknown": Truly unparseable input.

Decision heuristic — when in doubt:
1. "Can I answer this in 1-2 sentences from general knowledge?" → "question"
2. "Does this need file access, web search, code execution, research, or multiple steps?" → "open_session"
3. "Is the user just saying hi or being conversational?" → "greeting" or "question"

Extract project name if mentioned (e.g., "in my-app", "for the backend").

Session capabilities (what open_session can do):
- Execute code and terminal commands
- Read, write, and search files
- Run web searches and fetch URLs
- Git operations and project management
- Install packages, run tests, build projects
- Multi-step research and analysis
${capabilitiesSection}
Examples:
"hey there" → {"type": "greeting", "project": null, "task": null, "answer": "Hey! I'm Milo, your AI assistant. I can answer questions, tackle coding tasks, do research, automate workflows — whatever you need. What's up?"}
"what's 2+2?" → {"type": "question", "project": null, "task": null, "answer": "4"}
"who wrote hamlet?" → {"type": "question", "project": null, "task": null, "answer": "William Shakespeare."}
"what can you do?" → {"type": "question", "project": null, "task": null, "answer": "I can answer questions directly, and for bigger tasks I spin up terminal sessions that can write code, run commands, search the web, manage files, and more. Just tell me what you need!"}
"what's the weather in NYC?" → {"type": "question", "project": null, "task": null, "answer": "I don't have real-time weather data, but I can research it for you — just say 'look up the weather in NYC' and I'll spin up a session to find out."}
"thanks!" → {"type": "question", "project": null, "task": null, "answer": "You're welcome!"}
"fix the login bug" → {"type": "open_session", "project": null, "task": "fix the login bug"}
"work on my-api to add authentication" → {"type": "open_session", "project": "my-api", "task": "add authentication"}
"research best auth libraries for Node.js" → {"type": "open_session", "project": null, "task": "research best auth libraries for Node.js"}
"find all TODO comments in the codebase" → {"type": "open_session", "project": null, "task": "find all TODO comments in the codebase"}
"set up a cron job to back up my database nightly" → {"type": "open_session", "project": null, "task": "set up a cron job to back up my database nightly"}
"summarize the README in my-app" → {"type": "open_session", "project": "my-app", "task": "summarize the README"}`;
}

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
  const systemPrompt = buildSystemPrompt();
  const userPrompt = `Parse this message: "${content}"`;
  logger.verbose('  AI prompt (system):', systemPrompt);
  logger.verbose('  AI prompt (user):', userPrompt);

  const response = await complete(
    userPrompt,
    {
      system: systemPrompt,
      maxTokens: 512,
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

    if (parsed.type === 'question' && parsed.answer) {
      return {
        type: 'question',
        answer: parsed.answer,
        taskDescription: parsed.task ?? content,
        confidence: 0.8,
        raw: content,
      };
    }

    if (parsed.type === 'greeting' && parsed.answer) {
      return {
        type: 'greeting',
        answer: parsed.answer,
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
