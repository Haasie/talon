/**
 * Zod schemas for the talond configuration file.
 *
 * Every top-level schema has sensible defaults so a minimal config file
 * (or even an empty one) results in a valid, usable configuration.
 *
 * Schemas are kept internal to this file; callers should import the
 * inferred TypeScript types from `config-types.ts` and load configs
 * via `config-loader.ts`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const StorageConfigSchema = z.object({
  type: z.enum(['sqlite']).default('sqlite'),
  path: z.string().default('data/talond.sqlite'),
});

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const ResourceLimitsSchema = z.object({
  memoryMb: z.number().int().default(1024),
  cpus: z.number().default(1),
  pidsLimit: z.number().int().default(256),
});

export const SandboxConfigSchema = z.object({
  runtime: z.enum(['docker', 'apple-container']).default('docker'),
  image: z.string().default('talon-sandbox:latest'),
  maxConcurrent: z.number().int().min(1).default(3),
  networkDefault: z.enum(['off', 'on']).default('off'),
  idleTimeoutMs: z.number().int().min(0).default(30 * 60 * 1000),
  hardTimeoutMs: z.number().int().min(0).default(60 * 60 * 1000),
  resourceLimits: ResourceLimitsSchema.default(() => ResourceLimitsSchema.parse({})),
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CapabilitiesSchema = z.object({
  allow: z.array(z.string()).default([]),
  requireApproval: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

export const MountConfigSchema = z.object({
  source: z.string(),
  target: z.string(),
  mode: z.enum(['ro', 'rw']).default('ro'),
});

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().default('claude-sonnet-4-6'),
  systemPromptFile: z.string().optional(),
  skills: z.array(z.string()).default([]),
  subagents: z.array(z.string()).default([]),
  capabilities: CapabilitiesSchema.default(() => CapabilitiesSchema.parse({})),
  mounts: z.array(MountConfigSchema).default([]),
  maxConcurrent: z.number().int().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const ChannelConfigSchema = z.object({
  type: z.enum(['telegram', 'whatsapp', 'slack', 'email', 'discord', 'terminal']),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  tokenRef: z.string().optional(),
  enabled: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const IpcConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(100).default(500),
  daemonSocketDir: z.string().default('data/ipc/daemon'),
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const QueueConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  backoffBaseMs: z.number().int().default(1000),
  backoffMaxMs: z.number().int().default(60000),
  concurrencyLimit: z.number().int().min(1).default(5),
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export const SchedulerConfigSchema = z.object({
  tickIntervalMs: z.number().int().min(1000).default(5000),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const ProviderAuthSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});

export const AuthConfigSchema = z.object({
  mode: z.enum(['subscription', 'api_key']).default('subscription'),
  apiKey: z.string().optional(),
  providers: z.record(z.string(), ProviderAuthSchema).default({}),
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string(),
  contextWindowTokens: z.number().int().min(1000).default(200_000),
  rotationThreshold: z.number().min(0).max(1).default(0.4),
  options: z.record(z.string(), z.unknown()).optional(),
});

function defaultClaudeProviderConfig() {
  return ProviderConfigSchema.parse({
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200_000,
    rotationThreshold: 0.4,
  });
}

export const AgentRunnerConfigSchema = z.object({
  defaultProvider: z.string().default('claude-code'),
  providers: z
    .record(z.string(), ProviderConfigSchema)
    .default(() => ({ 'claude-code': defaultClaudeProviderConfig() })),
});

// ---------------------------------------------------------------------------
// Context (rolling context window)
// ---------------------------------------------------------------------------

export const ContextConfigSchema = z.object({
  /** Legacy token threshold fallback converted to provider rotation ratios. Default: 80 000. */
  thresholdTokens: z.number().int().min(10_000).default(80_000),
  /** Number of recent messages to include verbatim in fresh sessions. Default: 10. */
  recentMessageCount: z.number().int().min(0).default(10),
});

// ---------------------------------------------------------------------------
// Background agent
// ---------------------------------------------------------------------------

export const BackgroundAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  defaultTimeoutMinutes: z.number().int().min(15).max(480).default(30),
  defaultProvider: z.string().default('claude-code'),
  providers: z
    .record(z.string(), ProviderConfigSchema)
    .default(() => ({ 'claude-code': defaultClaudeProviderConfig() })),
  claudePath: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const TalondConfigSchema = z.object({
  storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
  sandbox: SandboxConfigSchema.default(() => SandboxConfigSchema.parse({})),
  channels: z.array(ChannelConfigSchema).default([]),
  personas: z.array(PersonaConfigSchema).default([]),
  ipc: IpcConfigSchema.default(() => IpcConfigSchema.parse({})),
  queue: QueueConfigSchema.default(() => QueueConfigSchema.parse({})),
  scheduler: SchedulerConfigSchema.default(() => SchedulerConfigSchema.parse({})),
  auth: AuthConfigSchema.default(() => AuthConfigSchema.parse({})),
  agentRunner: AgentRunnerConfigSchema.default(() => AgentRunnerConfigSchema.parse({})),
  context: ContextConfigSchema.default(() => ContextConfigSchema.parse({})),
  backgroundAgent: BackgroundAgentConfigSchema.default(() => BackgroundAgentConfigSchema.parse({})),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  dataDir: z.string().default('data'),
});
