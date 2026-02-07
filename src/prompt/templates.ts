/**
 * Prompt Templates for Enhancement
 *
 * System prompts and templates used by the prompt enhancer.
 */

/**
 * System prompt for the prompt enhancer
 */
export const ENHANCER_SYSTEM_PROMPT = `You are a prompt engineer that transforms casual user requests into clear, actionable prompts for Claude Code (an AI coding assistant).

Your job is to:
1. Clarify the user's intent
2. Add specific, actionable details
3. Include relevant constraints or requirements
4. Keep the prompt concise but complete

Rules:
- Output ONLY the enhanced prompt, nothing else
- Keep it under 500 words
- Use imperative mood ("Add", "Fix", "Create")
- Be specific about what files/components to modify if mentioned
- Include any mentioned constraints (language, framework, style)
- Do NOT add requirements the user didn't mention
- Do NOT include pleasantries or meta-commentary

Example input: "fix the login bug"
Example output: "Fix the login bug. Investigate the authentication flow, identify the issue, and implement a fix. Run relevant tests to verify the fix works correctly."

Example input: "add dark mode to the app"
Example output: "Add dark mode support to the application. Create a theme toggle component, implement CSS variables or a theme context for light/dark modes, and ensure all existing components respect the current theme setting."`;

/**
 * Template for enhancing a prompt with project context
 */
export function buildEnhancerPrompt(
  task: string,
  context?: ProjectContext
): string {
  let prompt = `Transform this user request into a clear prompt for Claude Code:\n\n"${task}"`;

  if (context) {
    prompt += '\n\nProject context:';

    if (context.projectName) {
      prompt += `\n- Project: ${context.projectName}`;
    }

    if (context.projectType) {
      prompt += `\n- Type: ${context.projectType}`;
    }

    if (context.techStack?.length) {
      prompt += `\n- Tech stack: ${context.techStack.join(', ')}`;
    }

    if (context.relevantFiles?.length) {
      prompt += `\n- Relevant files: ${context.relevantFiles.join(', ')}`;
    }

    if (context.additionalContext) {
      prompt += `\n- Notes: ${context.additionalContext}`;
    }
  }

  prompt += '\n\nEnhanced prompt:';

  return prompt;
}

/**
 * Project context for prompt enhancement
 */
export interface ProjectContext {
  projectName?: string;
  projectType?: string; // e.g., "Next.js app", "CLI tool", "React library"
  techStack?: string[]; // e.g., ["TypeScript", "React", "Prisma"]
  relevantFiles?: string[]; // e.g., ["src/auth/login.ts", "src/components/LoginForm.tsx"]
  additionalContext?: string; // Any other relevant info
}

/**
 * Common task type templates for quick enhancement without AI
 */
export const TASK_TEMPLATES: Record<string, (task: string) => string> = {
  fix: (task) =>
    `Fix the issue: ${task}. Investigate the root cause, implement a fix, and verify it works correctly. Add or update tests if applicable.`,

  add: (task) =>
    `Add the following feature: ${task}. Implement it following existing code patterns and conventions. Include appropriate error handling and tests.`,

  refactor: (task) =>
    `Refactor: ${task}. Improve the code structure while maintaining existing functionality. Ensure all tests pass after refactoring.`,

  update: (task) =>
    `Update: ${task}. Make the necessary changes while maintaining backward compatibility where possible. Update related documentation if needed.`,

  create: (task) =>
    `Create: ${task}. Follow the project's existing patterns and conventions. Include appropriate type definitions, error handling, and basic tests.`,

  debug: (task) =>
    `Debug: ${task}. Investigate the issue, add logging if needed to trace the problem, identify the root cause, and implement a fix.`,

  implement: (task) =>
    `Implement: ${task}. Design and build the feature following project conventions. Include error handling, type safety, and tests.`,

  remove: (task) =>
    `Remove: ${task}. Carefully delete the specified code/feature, update all references, and ensure no broken imports or functionality remain.`,

  optimize: (task) =>
    `Optimize: ${task}. Analyze performance, implement improvements, and verify the optimization doesn't break existing functionality.`,

  test: (task) =>
    `Write tests for: ${task}. Cover happy path, edge cases, and error scenarios. Follow the project's existing test patterns.`,
};

/**
 * Detect task type from the task description
 */
export function detectTaskType(task: string): string | null {
  const firstWord = task.trim().split(/\s+/)[0].toLowerCase();
  const taskTypes = Object.keys(TASK_TEMPLATES);

  // Direct match
  if (taskTypes.includes(firstWord)) {
    return firstWord;
  }

  // Synonym mapping
  const synonyms: Record<string, string> = {
    build: 'create',
    make: 'create',
    setup: 'create',
    configure: 'create',
    change: 'update',
    modify: 'update',
    improve: 'optimize',
    delete: 'remove',
    write: 'create',
  };

  if (synonyms[firstWord]) {
    return synonyms[firstWord];
  }

  return null;
}
