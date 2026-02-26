/**
 * Configuration loading and validation.
 *
 * Reads talond.yaml, parses with js-yaml, and validates against the Zod schema.
 * Exports a strongly-typed TalondConfig object for use throughout the daemon.
 */

export {
  loadConfig,
  loadConfigFromString,
  validateConfig,
} from './config-loader.js';

export {
  TalondConfigSchema,
  StorageConfigSchema,
  SandboxConfigSchema,
  CapabilitiesSchema,
  MountConfigSchema,
  PersonaConfigSchema,
  ChannelConfigSchema,
  ScheduleConfigSchema,
  IpcConfigSchema,
  QueueConfigSchema,
  SchedulerConfigSchema,
  AuthConfigSchema,
} from './config-schema.js';

export type {
  TalondConfig,
  StorageConfig,
  SandboxConfig,
  SandboxResourceLimits,
  CapabilitiesConfig,
  MountConfig,
  PersonaConfig,
  ChannelConfig,
  ScheduleConfig,
  IpcConfig,
  QueueConfig,
  SchedulerConfig,
  AuthConfig,
} from './config-types.js';
