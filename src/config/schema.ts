import { z } from 'zod';

/**
 * Zod schema for agent configuration validation
 */

export const workspaceConfigSchema = z.object({
  baseDir: z.string(),
  projectsDir: z.string().default('projects'),
  sessionsDir: z.string().default('SESSION'),
  templatesDir: z.string().default('templates'),
  toolsDir: z.string().default('tools'),
});

export const claudeCodeConfigSchema = z.object({
  maxConcurrentSessions: z.number().min(1).max(10).default(3),
  startupMaxRetries: z.number().min(1).max(10).default(5),
  startupRetryIntervalSeconds: z.number().min(10).max(120).default(30),
});

export const schedulerConfigSchema = z.object({
  heartbeatIntervalMinutes: z.number().min(1).max(60).default(3),
  userNotificationThrottleMinutes: z.number().min(1).max(60).default(20),
});

export const tasksConfigSchema = z.object({
  maxRetries: z.number().min(1).max(10).default(3),
});

export const toolsConfigSchema = z.object({
  safeTools: z.array(z.string()).default([]),
  requireConfirmation: z.array(z.string()).default([]),
});

export const webappMessagingConfigSchema = z.object({
  apiUrl: z.string().url().default('https://www.milobot.dev/api'),
  pollIntervalMs: z.number().min(1000).default(60000),
});

export const telegramMessagingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

export const messagingConfigSchema = z.object({
  activeAdapter: z.enum(['webapp', 'telegram']).default('webapp'),
  webapp: webappMessagingConfigSchema.default({}),
  telegram: telegramMessagingConfigSchema.default({}),
});

export const agentConfigSchema = z.object({
  agentName: z.string().min(1).max(100),
  agentId: z.string().optional(),
  aliases: z.record(z.string()).default({
    CC: 'Claude Code',
    claude: 'Claude Code',
  }),
  workspace: workspaceConfigSchema,
  claudeCode: claudeCodeConfigSchema.default({}),
  scheduler: schedulerConfigSchema.default({}),
  tasks: tasksConfigSchema.default({}),
  tools: toolsConfigSchema.default({}),
  messaging: messagingConfigSchema.default({}),
  onboardingComplete: z.boolean().default(false),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type ClaudeCodeConfig = z.infer<typeof claudeCodeConfigSchema>;
export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
export type TasksConfig = z.infer<typeof tasksConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type MessagingConfig = z.infer<typeof messagingConfigSchema>;
