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
  personasDir: z.string().default('PERSONAS'),
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
  pollIntervalMs: z.number().min(1000).default(180000),
});

export const telegramMessagingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

const aiModelConfigSchema = z.object({
  provider: z.string().default('anthropic'),
  model: z.string(),
});

export const aiConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-5'),
  agent: aiModelConfigSchema.default({
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  }),
  utility: aiModelConfigSchema.default({
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
  }),
});

export const messagingConfigSchema = z.object({
  activeAdapter: z.enum(['webapp', 'telegram']).default('webapp'),
  webapp: webappMessagingConfigSchema.default({}),
  telegram: telegramMessagingConfigSchema.default({}),
});

export const pubnubConfigSchema = z.object({
  enabled: z.boolean().default(true),
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
  ai: aiConfigSchema.default({}),
  messaging: messagingConfigSchema.default({}),
  pubnub: pubnubConfigSchema.default({}),
  streaming: z.boolean().default(true),
  onboardingComplete: z.boolean().default(false),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type ClaudeCodeConfig = z.infer<typeof claudeCodeConfigSchema>;
export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
export type TasksConfig = z.infer<typeof tasksConfigSchema>;
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type AIConfig = z.infer<typeof aiConfigSchema>;
export type MessagingConfig = z.infer<typeof messagingConfigSchema>;
