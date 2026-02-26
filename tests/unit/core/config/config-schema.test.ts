import { describe, it, expect } from 'vitest';
import {
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
} from '../../../../src/core/config/config-schema.js';

// ---------------------------------------------------------------------------
// StorageConfigSchema
// ---------------------------------------------------------------------------

describe('StorageConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = StorageConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('sqlite');
      expect(result.data.path).toBe('data/talond.sqlite');
    }
  });

  it('accepts a valid explicit config', () => {
    const result = StorageConfigSchema.safeParse({ type: 'sqlite', path: '/tmp/test.db' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/tmp/test.db');
    }
  });

  it('rejects an unknown storage type', () => {
    const result = StorageConfigSchema.safeParse({ type: 'postgres' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SandboxConfigSchema
// ---------------------------------------------------------------------------

describe('SandboxConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = SandboxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('docker');
      expect(result.data.image).toBe('talon-sandbox:latest');
      expect(result.data.maxConcurrent).toBe(3);
      expect(result.data.networkDefault).toBe('off');
      expect(result.data.idleTimeoutMs).toBe(30 * 60 * 1000);
      expect(result.data.hardTimeoutMs).toBe(60 * 60 * 1000);
      expect(result.data.resourceLimits.memoryMb).toBe(1024);
      expect(result.data.resourceLimits.cpus).toBe(1);
      expect(result.data.resourceLimits.pidsLimit).toBe(256);
    }
  });

  it('accepts apple-container runtime', () => {
    const result = SandboxConfigSchema.safeParse({ runtime: 'apple-container' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('apple-container');
    }
  });

  it('rejects an unknown runtime', () => {
    const result = SandboxConfigSchema.safeParse({ runtime: 'lxc' });
    expect(result.success).toBe(false);
  });

  it('rejects maxConcurrent below 1', () => {
    const result = SandboxConfigSchema.safeParse({ maxConcurrent: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative idleTimeoutMs', () => {
    const result = SandboxConfigSchema.safeParse({ idleTimeoutMs: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts custom resourceLimits', () => {
    const result = SandboxConfigSchema.safeParse({
      resourceLimits: { memoryMb: 2048, cpus: 2, pidsLimit: 512 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLimits.memoryMb).toBe(2048);
    }
  });
});

// ---------------------------------------------------------------------------
// CapabilitiesSchema
// ---------------------------------------------------------------------------

describe('CapabilitiesSchema', () => {
  it('parses an empty object with empty arrays', () => {
    const result = CapabilitiesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow).toEqual([]);
      expect(result.data.requireApproval).toEqual([]);
    }
  });

  it('accepts allow and requireApproval lists', () => {
    const result = CapabilitiesSchema.safeParse({
      allow: ['read_file', 'list_dir'],
      requireApproval: ['write_file'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allow).toContain('read_file');
      expect(result.data.requireApproval).toContain('write_file');
    }
  });

  it('rejects non-string items in allow', () => {
    const result = CapabilitiesSchema.safeParse({ allow: [42] });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MountConfigSchema
// ---------------------------------------------------------------------------

describe('MountConfigSchema', () => {
  it('requires source and target', () => {
    expect(MountConfigSchema.safeParse({}).success).toBe(false);
    expect(MountConfigSchema.safeParse({ source: '/src' }).success).toBe(false);
    expect(MountConfigSchema.safeParse({ target: '/dst' }).success).toBe(false);
  });

  it('defaults mode to ro', () => {
    const result = MountConfigSchema.safeParse({ source: '/src', target: '/dst' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('ro');
    }
  });

  it('accepts rw mode', () => {
    const result = MountConfigSchema.safeParse({ source: '/src', target: '/dst', mode: 'rw' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('rw');
    }
  });

  it('rejects an invalid mode', () => {
    const result = MountConfigSchema.safeParse({ source: '/src', target: '/dst', mode: 'exec' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PersonaConfigSchema
// ---------------------------------------------------------------------------

describe('PersonaConfigSchema', () => {
  it('requires a non-empty name', () => {
    expect(PersonaConfigSchema.safeParse({}).success).toBe(false);
    expect(PersonaConfigSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('parses a minimal persona with defaults', () => {
    const result = PersonaConfigSchema.safeParse({ name: 'assistant' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('claude-sonnet-4-6');
      expect(result.data.skills).toEqual([]);
      expect(result.data.capabilities.allow).toEqual([]);
      expect(result.data.mounts).toEqual([]);
      expect(result.data.systemPromptFile).toBeUndefined();
      expect(result.data.maxConcurrent).toBeUndefined();
    }
  });

  it('accepts a fully-specified persona', () => {
    const result = PersonaConfigSchema.safeParse({
      name: 'researcher',
      model: 'claude-opus-4-6',
      systemPromptFile: '/prompts/researcher.md',
      skills: ['web-search', 'code-runner'],
      capabilities: { allow: ['read_file'], requireApproval: [] },
      mounts: [{ source: '/data', target: '/workspace', mode: 'rw' }],
      maxConcurrent: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('researcher');
      expect(result.data.maxConcurrent).toBe(2);
      expect(result.data.mounts).toHaveLength(1);
    }
  });

  it('rejects maxConcurrent below 1', () => {
    const result = PersonaConfigSchema.safeParse({ name: 'bot', maxConcurrent: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChannelConfigSchema
// ---------------------------------------------------------------------------

describe('ChannelConfigSchema', () => {
  it('requires type and name', () => {
    expect(ChannelConfigSchema.safeParse({}).success).toBe(false);
    expect(ChannelConfigSchema.safeParse({ type: 'telegram' }).success).toBe(false);
    expect(ChannelConfigSchema.safeParse({ name: 'main' }).success).toBe(false);
  });

  it('defaults enabled to true and config to {}', () => {
    const result = ChannelConfigSchema.safeParse({ type: 'telegram', name: 'main' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.config).toEqual({});
      expect(result.data.tokenRef).toBeUndefined();
    }
  });

  it('accepts all supported channel types', () => {
    const types = ['telegram', 'whatsapp', 'slack', 'email', 'discord'] as const;
    for (const type of types) {
      const result = ChannelConfigSchema.safeParse({ type, name: type });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown channel type', () => {
    const result = ChannelConfigSchema.safeParse({ type: 'signal', name: 'signal' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty name', () => {
    const result = ChannelConfigSchema.safeParse({ type: 'telegram', name: '' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScheduleConfigSchema
// ---------------------------------------------------------------------------

describe('ScheduleConfigSchema', () => {
  it('requires name, personaName, type, and expression', () => {
    expect(ScheduleConfigSchema.safeParse({}).success).toBe(false);
  });

  it('parses a minimal schedule with defaults', () => {
    const result = ScheduleConfigSchema.safeParse({
      name: 'daily-digest',
      personaName: 'assistant',
      type: 'cron',
      expression: '0 9 * * *',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({});
      expect(result.data.enabled).toBe(true);
      expect(result.data.threadId).toBeUndefined();
    }
  });

  it('accepts all schedule types', () => {
    const types = ['cron', 'interval', 'one_shot', 'event'] as const;
    for (const type of types) {
      const result = ScheduleConfigSchema.safeParse({
        name: 'task',
        personaName: 'bot',
        type,
        expression: '5000',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid schedule type', () => {
    const result = ScheduleConfigSchema.safeParse({
      name: 'task',
      personaName: 'bot',
      type: 'timer',
      expression: '5000',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IpcConfigSchema
// ---------------------------------------------------------------------------

describe('IpcConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = IpcConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pollIntervalMs).toBe(500);
      expect(result.data.daemonSocketDir).toBe('data/ipc/daemon');
    }
  });

  it('rejects pollIntervalMs below 100', () => {
    const result = IpcConfigSchema.safeParse({ pollIntervalMs: 99 });
    expect(result.success).toBe(false);
  });

  it('accepts pollIntervalMs of exactly 100', () => {
    const result = IpcConfigSchema.safeParse({ pollIntervalMs: 100 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QueueConfigSchema
// ---------------------------------------------------------------------------

describe('QueueConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = QueueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxAttempts).toBe(3);
      expect(result.data.backoffBaseMs).toBe(1000);
      expect(result.data.backoffMaxMs).toBe(60000);
      expect(result.data.concurrencyLimit).toBe(5);
    }
  });

  it('rejects maxAttempts below 1', () => {
    const result = QueueConfigSchema.safeParse({ maxAttempts: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects concurrencyLimit below 1', () => {
    const result = QueueConfigSchema.safeParse({ concurrencyLimit: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SchedulerConfigSchema
// ---------------------------------------------------------------------------

describe('SchedulerConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = SchedulerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tickIntervalMs).toBe(5000);
    }
  });

  it('rejects tickIntervalMs below 1000', () => {
    const result = SchedulerConfigSchema.safeParse({ tickIntervalMs: 999 });
    expect(result.success).toBe(false);
  });

  it('accepts tickIntervalMs of exactly 1000', () => {
    const result = SchedulerConfigSchema.safeParse({ tickIntervalMs: 1000 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuthConfigSchema
// ---------------------------------------------------------------------------

describe('AuthConfigSchema', () => {
  it('parses an empty object with defaults', () => {
    const result = AuthConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('subscription');
      expect(result.data.apiKey).toBeUndefined();
    }
  });

  it('accepts api_key mode with an apiKey', () => {
    const result = AuthConfigSchema.safeParse({ mode: 'api_key', apiKey: 'sk-test-abc123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('api_key');
      expect(result.data.apiKey).toBe('sk-test-abc123');
    }
  });

  it('accepts subscription mode without apiKey', () => {
    const result = AuthConfigSchema.safeParse({ mode: 'subscription' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown auth mode', () => {
    const result = AuthConfigSchema.safeParse({ mode: 'oauth' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TalondConfigSchema (root)
// ---------------------------------------------------------------------------

describe('TalondConfigSchema', () => {
  it('parses an empty object — all defaults applied', () => {
    const result = TalondConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logLevel).toBe('info');
      expect(result.data.dataDir).toBe('data');
      expect(result.data.channels).toEqual([]);
      expect(result.data.personas).toEqual([]);
      expect(result.data.schedules).toEqual([]);
      expect(result.data.storage.type).toBe('sqlite');
      expect(result.data.ipc.pollIntervalMs).toBe(500);
      expect(result.data.queue.maxAttempts).toBe(3);
      expect(result.data.scheduler.tickIntervalMs).toBe(5000);
      expect(result.data.auth.mode).toBe('subscription');
    }
  });

  it('accepts a fully-specified configuration', () => {
    const result = TalondConfigSchema.safeParse({
      logLevel: 'debug',
      dataDir: '/var/lib/talon',
      storage: { type: 'sqlite', path: '/var/lib/talon/db.sqlite' },
      sandbox: { runtime: 'docker', maxConcurrent: 5 },
      channels: [{ type: 'telegram', name: 'main', tokenRef: 'TELEGRAM_TOKEN' }],
      personas: [{ name: 'helper', model: 'claude-sonnet-4-6' }],
      schedules: [
        {
          name: 'morning-brief',
          personaName: 'helper',
          type: 'cron',
          expression: '0 8 * * *',
        },
      ],
      ipc: { pollIntervalMs: 250 },
      queue: { maxAttempts: 5 },
      scheduler: { tickIntervalMs: 10000 },
      auth: { mode: 'api_key', apiKey: 'sk-ant-test' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logLevel).toBe('debug');
      expect(result.data.channels).toHaveLength(1);
      expect(result.data.personas).toHaveLength(1);
      expect(result.data.schedules).toHaveLength(1);
    }
  });

  it('rejects an invalid logLevel', () => {
    const result = TalondConfigSchema.safeParse({ logLevel: 'verbose' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid logLevel values', () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) {
      const result = TalondConfigSchema.safeParse({ logLevel: level });
      expect(result.success).toBe(true);
    }
  });

  it('ignores extra top-level fields (strips by default)', () => {
    const result = TalondConfigSchema.safeParse({ unknownField: 'value' });
    // Zod strips unknown fields by default — parse should still succeed
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['unknownField']).toBeUndefined();
    }
  });
});
