/**
 * Prompt Enhancer
 *
 * Transforms user task descriptions into clear, actionable prompts
 * for Claude Code. Uses templates for common patterns and AI for
 * complex or ambiguous requests.
 */

import { complete, isAIAvailable, truncateToTokens } from '../utils/ai-client';
import {
  ENHANCER_SYSTEM_PROMPT,
  buildEnhancerPrompt,
  TASK_TEMPLATES,
  detectTaskType,
  type ProjectContext,
} from './templates';
import { logger } from '../utils/logger';

/**
 * Options for prompt enhancement
 */
export interface EnhanceOptions {
  /** Project context to include in enhancement */
  context?: ProjectContext;
  /** Force AI enhancement even if template matches */
  forceAI?: boolean;
  /** Skip AI and use templates only */
  templatesOnly?: boolean;
  /** Maximum tokens for context (to avoid exceeding limits) */
  maxContextTokens?: number;
}

/**
 * Result of prompt enhancement
 */
export interface EnhanceResult {
  /** The enhanced prompt */
  prompt: string;
  /** Whether AI was used for enhancement */
  usedAI: boolean;
  /** The template type if a template was used */
  templateType?: string;
  /** Original task for reference */
  original: string;
}

/**
 * Enhance a user's task description into a clear prompt for Claude Code
 *
 * Strategy:
 * 1. Try template-based enhancement for known task patterns
 * 2. Fall back to AI enhancement for complex/unclear tasks
 * 3. Return original with minimal formatting if AI unavailable
 *
 * @param task - The user's raw task description
 * @param options - Enhancement options
 * @returns Enhanced prompt result
 */
export async function enhancePrompt(
  task: string,
  options: EnhanceOptions = {}
): Promise<EnhanceResult> {
  const trimmedTask = task.trim();

  // Try template-based enhancement first (fast, no API call)
  if (!options.forceAI) {
    logger.verbose('  Trying template-based enhancement...');
    const templateResult = tryTemplateEnhancement(trimmedTask);
    if (templateResult) {
      logger.verbose(`  Template matched: ${templateResult.templateType}`);
      return templateResult;
    }
    logger.verbose('  No template matched');
  }

  // If templates-only mode, return minimal enhancement
  if (options.templatesOnly) {
    logger.verbose('  Templates-only mode, using minimal enhancement');
    return {
      prompt: minimalEnhancement(trimmedTask),
      usedAI: false,
      original: trimmedTask,
    };
  }

  // Try AI enhancement
  if (isAIAvailable()) {
    try {
      logger.verbose('  Enhancing with AI...');
      const aiResult = await aiEnhancement(trimmedTask, options);
      logger.verbose(`  AI enhancement complete (${aiResult.prompt.length} chars)`);
      return aiResult;
    } catch (error) {
      logger.warn('AI enhancement failed, falling back to minimal:', error);
    }
  } else {
    logger.verbose('  AI not available, using minimal enhancement');
  }

  // Final fallback: minimal enhancement
  logger.verbose('  Using minimal enhancement (capitalize + period)');
  return {
    prompt: minimalEnhancement(trimmedTask),
    usedAI: false,
    original: trimmedTask,
  };
}

/**
 * Try to enhance using a matching template
 */
function tryTemplateEnhancement(task: string): EnhanceResult | null {
  const taskType = detectTaskType(task);

  if (!taskType || !TASK_TEMPLATES[taskType]) {
    return null;
  }

  // Remove the verb from the task for cleaner template insertion
  const taskWithoutVerb = task
    .trim()
    .replace(new RegExp(`^${taskType}\\s*`, 'i'), '')
    .trim();

  // If removing the verb leaves nothing meaningful, don't use template
  if (taskWithoutVerb.length < 3) {
    return null;
  }

  const template = TASK_TEMPLATES[taskType];
  const enhancedPrompt = template(taskWithoutVerb);

  return {
    prompt: enhancedPrompt,
    usedAI: false,
    templateType: taskType,
    original: task,
  };
}

/**
 * Enhance using AI (Claude API)
 */
async function aiEnhancement(
  task: string,
  options: EnhanceOptions
): Promise<EnhanceResult> {
  // Prepare context, truncating if needed
  let context = options.context;
  if (context && options.maxContextTokens) {
    context = truncateContext(context, options.maxContextTokens);
  }

  const prompt = buildEnhancerPrompt(task, context);

  const enhanced = await complete(prompt, {
    system: ENHANCER_SYSTEM_PROMPT,
    maxTokens: 512,
    temperature: 0.3,
  });

  return {
    prompt: enhanced.trim(),
    usedAI: true,
    original: task,
  };
}

/**
 * Minimal enhancement when AI is unavailable
 */
function minimalEnhancement(task: string): string {
  // Capitalize first letter
  const capitalized = task.charAt(0).toUpperCase() + task.slice(1);

  // Ensure it ends with a period
  const withPeriod = capitalized.endsWith('.') ? capitalized : `${capitalized}.`;

  return withPeriod;
}

/**
 * Truncate context to fit within token limit
 */
function truncateContext(
  context: ProjectContext,
  maxTokens: number
): ProjectContext {
  const result = { ...context };

  // Truncate additional context first (usually the longest)
  if (result.additionalContext) {
    result.additionalContext = truncateToTokens(
      result.additionalContext,
      Math.floor(maxTokens * 0.5)
    );
  }

  // Limit relevant files list
  if (result.relevantFiles && result.relevantFiles.length > 10) {
    result.relevantFiles = result.relevantFiles.slice(0, 10);
  }

  // Limit tech stack list
  if (result.techStack && result.techStack.length > 10) {
    result.techStack = result.techStack.slice(0, 10);
  }

  return result;
}

/**
 * Check if a task would benefit from AI enhancement
 * (vs template-only enhancement)
 */
export function shouldUseAI(task: string): boolean {
  // If template matches, AI not needed
  if (detectTaskType(task)) {
    return false;
  }

  // Short tasks might be ambiguous
  if (task.split(/\s+/).length < 4) {
    return true;
  }

  // Tasks with questions benefit from AI
  if (task.includes('?')) {
    return true;
  }

  // Complex tasks with multiple parts
  if (task.includes(' and ') || task.includes(' then ')) {
    return true;
  }

  return true; // Default to AI for anything unclear
}
