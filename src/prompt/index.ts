/**
 * Prompt Enhancement Module
 *
 * Exports the prompt enhancer and related utilities.
 */

export {
  enhancePrompt,
  shouldUseAI,
  type EnhanceOptions,
  type EnhanceResult,
} from './enhancer';

export {
  ENHANCER_SYSTEM_PROMPT,
  TASK_TEMPLATES,
  detectTaskType,
  buildEnhancerPrompt,
  type ProjectContext,
} from './templates';
