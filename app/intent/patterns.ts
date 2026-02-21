/**
 * Intent Pattern Matching
 *
 * Regex patterns for extracting intent from user messages.
 * Patterns are ordered by specificity - more specific patterns first.
 */

import type { PatternMatchResult, AliasMap } from './types';

/**
 * Task verbs that indicate action intent
 */
const TASK_VERBS = [
  'fix',
  'add',
  'build',
  'create',
  'implement',
  'update',
  'refactor',
  'debug',
  'write',
  'make',
  'setup',
  'configure',
  'remove',
  'delete',
  'change',
  'modify',
  'improve',
  'optimize',
] as const;

/**
 * Pattern definitions with named capture groups
 * Each pattern extracts: project (optional), task (required)
 */
const OPEN_SESSION_PATTERNS: Array<{
  pattern: RegExp;
  confidence: number;
  description: string;
}> = [
  {
    // "work on <project> to <task>"
    pattern: /^work\s+on\s+(?<project>[\w-]+)\s+to\s+(?<task>.+)$/i,
    confidence: 0.9,
    description: 'work on project to task',
  },
  {
    // "in <project>: <task>" or "in <project>, <task>"
    pattern: /^in\s+(?<project>[\w-]+)[,:]\s*(?<task>.+)$/i,
    confidence: 0.9,
    description: 'in project: task',
  },
  {
    // "<task> in <project>" (project at end)
    pattern: /^(?<task>.+)\s+in\s+(?<project>[\w-]+)$/i,
    confidence: 0.9,
    description: 'task in project',
  },
  {
    // "start session for <task>" or "start session: <task>"
    pattern: /^start\s+(?:a\s+)?session\s+(?:for\s+|:\s*)?(?<task>.+)$/i,
    confidence: 0.8,
    description: 'start session for task',
  },
  {
    // "new session: <task>"
    pattern: /^new\s+session[:\s]+(?<task>.+)$/i,
    confidence: 0.8,
    description: 'new session: task',
  },
  {
    // "<verb> <task>" - generic task verb pattern
    pattern: new RegExp(
      `^(?<verb>${TASK_VERBS.join('|')})\\s+(?<task>.+)$`,
      'i'
    ),
    confidence: 0.7,
    description: 'verb task',
  },
];

/**
 * Try to match a message against open_session patterns
 */
export function matchOpenSessionPatterns(
  content: string
): PatternMatchResult {
  const trimmed = content.trim();

  for (const { pattern, confidence } of OPEN_SESSION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.groups) {
      return {
        matched: true,
        project: match.groups.project?.trim(),
        task: match.groups.task?.trim(),
        confidence,
      };
    }
  }

  return { matched: false, confidence: 0 };
}

/**
 * Resolve project name through alias lookup
 */
export function resolveProjectAlias(
  projectName: string | undefined,
  aliases: AliasMap
): string | undefined {
  if (!projectName) return undefined;

  const normalized = projectName.toLowerCase();

  // Check direct alias match
  if (aliases[normalized]) {
    return aliases[normalized];
  }

  // Check if it's already a real project name (not an alias)
  const aliasValues = Object.values(aliases);
  if (aliasValues.includes(projectName)) {
    return projectName;
  }

  // Return as-is (might be a direct project name)
  return projectName;
}

/**
 * Generate a session name from task description
 */
export function generateSessionName(task: string, maxLength = 50): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim hyphens
    .slice(0, maxLength);
}

/**
 * Common greeting words/phrases
 */
const GREETING_PATTERNS = [
  /^(hi|hello|hey|yo|sup|howdy|hola|greetings)\b/i,
  /^good\s+(morning|afternoon|evening|day)\b/i,
  /^what'?s\s+up\b/i,
  /^how'?s\s+it\s+going\b/i,
];

/**
 * Check if content is a greeting
 */
export function matchGreetingPatterns(content: string): boolean {
  const trimmed = content.trim();
  return GREETING_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Patterns for listing projects
 */
const LIST_PROJECTS_PATTERNS = [
  /^\/projects$/i,
  /^(list|show|get)\s+(the\s+)?projects?\s*(list|folders?)?$/i,
  /^what\s+projects?\s+(are\s+there|do\s+(i|we)\s+have|exist)/i,
  /^projects?\s*$/i,
];

/**
 * Check if content is a list-projects request
 */
export function matchListProjectsPatterns(content: string): boolean {
  const trimmed = content.trim();
  return LIST_PROJECTS_PATTERNS.some((p) => p.test(trimmed));
}


/**
 * Check if content looks like a task (starts with verb or has task indicators)
 */
export function looksLikeTask(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  const firstWord = trimmed.split(/\s+/)[0];

  // Starts with task verb
  if (TASK_VERBS.some((v) => v === firstWord)) {
    return true;
  }

  // Contains task-like phrases
  const taskPhrases = [
    'can you',
    'please',
    'i need',
    'i want',
    'help me',
    'could you',
  ];
  if (taskPhrases.some((phrase) => trimmed.startsWith(phrase))) {
    return true;
  }

  return false;
}
