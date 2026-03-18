/**
 * Unit tests for daemon-bootstrap bootstrap().
 *
 * Nearly every dependency is mocked at the module level since bootstrap()
 * wires together the entire daemon subsystem graph. Tests verify that
 * failures at each stage are handled correctly and that a successful
 * bootstrap produces a fully populated DaemonContext.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import type pino from 'pino';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/config/config-loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../src/core/database/connection.js', () => ({
  createDatabase: vi.fn(),
}));

vi.mock('../../../src/core/database/migrations/runner.js', () => ({
  runMigrations: vi.fn(),
}));

vi.mock('../../../src/core/database/repositories/index.js', () => ({
  QueueRepository: vi.fn().mockImplementation(() => ({})),
  ThreadRepository: vi.fn().mockImplementation(() => ({})),
  ChannelRepository: vi.fn().mockImplementation(() => ({})),
  PersonaRepository: vi.fn().mockImplementation(() => ({})),
  BackgroundTaskRepository: vi.fn().mockImplementation(() => ({})),
  ScheduleRepository: vi.fn().mockImplementation(() => ({})),
  AuditRepository: vi.fn().mockImplementation(() => ({})),
  MessageRepository: vi.fn().mockImplementation(() => ({})),
  RunRepository: vi.fn().mockImplementation(() => ({})),
  BindingRepository: vi.fn().mockImplementation(() => ({})),
  MemoryRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/core/database/repositories/audit-repository.js', () => ({
  RepositoryAuditStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/core/logging/audit-logger.js', () => ({
  AuditLogger: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/personas/persona-loader.js', () => ({
  PersonaLoader: vi.fn().mockImplementation(() => ({
    loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    getByName: vi.fn().mockReturnValue(ok({})),
  })),
}));

vi.mock('../../../src/skills/skill-loader.js', () => ({
  SkillLoader: vi.fn().mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  })),
}));

vi.mock('../../../src/skills/skill-resolver.js', () => ({
  SkillResolver: vi.fn().mockImplementation(() => ({
    mergePromptFragments: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('../../../src/channels/channel-registry.js', () => ({
  ChannelRegistry: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../../src/channels/channel-router.js', () => ({
  ChannelRouter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/channels/channel-setup.js', () => ({
  registerChannels: vi.fn(),
}));

vi.mock('../../../src/pipeline/message-pipeline.js', () => ({
  MessagePipeline: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/queue/queue-manager.js', () => ({
  QueueManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/scheduler/scheduler.js', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/memory/thread-workspace.js', () => ({
  ThreadWorkspace: vi.fn().mockImplementation(() => ({
    ensureDirectories: vi.fn().mockReturnValue(ok('/tmp/workspace')),
  })),
}));

vi.mock('../../../src/sandbox/session-tracker.js', () => ({
  SessionTracker: vi.fn().mockImplementation(() => ({
    getSessionId: vi.fn(),
    setSessionId: vi.fn(),
  })),
}));

vi.mock('../../../src/tools/host-tools-bridge.js', () => ({
  HostToolsBridge: vi.fn().mockImplementation(() => ({
    path: '/tmp/host-tools.sock',
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../../src/subagents/background/background-agent-manager.js', () => ({
  BackgroundAgentManager: vi.fn().mockImplementation(() => ({
    recoverOrphanedTasks: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

vi.mock('../../../src/daemon/lifecycle.js', () => ({
  recoverFromCrash: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { bootstrap } from '../../../src/daemon/daemon-bootstrap.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { createDatabase } from '../../../src/core/database/connection.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';
import { SkillLoader } from '../../../src/skills/skill-loader.js';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import { recoverFromCrash } from '../../../src/daemon/lifecycle.js';
import { registerChannels } from '../../../src/channels/channel-setup.js';
import { BackgroundTaskRepository } from '../../../src/core/database/repositories/index.js';
import { BackgroundAgentManager } from '../../../src/subagents/background/background-agent-manager.js';
import { createDiscardLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return createDiscardLogger('silent');
}

/** Minimal valid TalondConfig fixture. */
function makeConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    storage: { type: 'sqlite', path: ':memory:' },
    dataDir: '/tmp/test-data',
    logLevel: 'info',
    channels: [],
    personas: [],
    schedules: [],
    ipc: { pollIntervalMs: 500, daemonSocketDir: 'data/ipc/daemon' },
    queue: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 },
    scheduler: { tickIntervalMs: 5000 },
    sandbox: {
      runtime: 'docker',
      image: 'talon-sandbox:latest',
      maxConcurrent: 3,
      networkDefault: 'off',
      idleTimeoutMs: 1800000,
      hardTimeoutMs: 3600000,
      resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
    },
    auth: { mode: 'subscription' },
    agentRunner: {
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          rotationThreshold: 0.4,
        },
      },
    },
    context: { thresholdTokens: 80_000, recentMessageCount: 10 },
    backgroundAgent: {
      enabled: true,
      maxConcurrent: 3,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          rotationThreshold: 0.4,
        },
      },
    },
    ...overrides,
  };
}

function makeMockDb() {
  const mockStatement = {
    run: vi.fn().mockReturnValue({ changes: 0, lastInsertRowid: 0 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    pragma: vi.fn().mockReturnValue(0),
    exec: vi.fn(),
    close: vi.fn(),
  };
}

/**
 * Sets up mocks for a fully successful bootstrap.
 * Returns the mock DB for assertions.
 */
function setupSuccessfulMocks() {
  const config = makeConfig();
  const db = makeMockDb();

  vi.mocked(loadConfig).mockReturnValue(ok(config as any));
  vi.mocked(createDatabase).mockReturnValue(ok(db as any));
  vi.mocked(runMigrations).mockReturnValue(ok(1));

  // Restore constructor mocks in case previous tests overrode them.
  vi.mocked(PersonaLoader).mockImplementation(() => ({
    loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
    getByName: vi.fn().mockReturnValue(ok({})),
  }) as any);
  vi.mocked(SkillLoader).mockImplementation(() => ({
    loadFromPersonaConfig: vi.fn().mockResolvedValue(ok([])),
  }) as any);

  return { config, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  let logger: pino.Logger;

  beforeEach(() => {
    logger = createSilentLogger();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Failure scenarios
  // -------------------------------------------------------------------------

  describe('failure scenarios', () => {
    it('returns error when config loading fails', async () => {
      vi.mocked(loadConfig).mockReturnValue(
        err(new Error('config file not found') as any),
      );

      const result = await bootstrap('/missing.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to load config');
    });

    it('returns error when database creation fails', async () => {
      const config = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(
        err(new Error('cannot open database') as any),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to open database');
    });

    it('returns error when migrations fail and closes db', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(ok(db as any));
      vi.mocked(runMigrations).mockReturnValue(
        err(new Error('migration 003 failed') as any),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to run migrations');
      expect(db.close).toHaveBeenCalledOnce();
    });

    it('returns error when persona loading fails and closes db', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(ok(db as any));
      vi.mocked(runMigrations).mockReturnValue(ok(0));

      // Override the PersonaLoader mock to make loadFromConfig fail.
      vi.mocked(PersonaLoader).mockImplementation(() => ({
        loadFromConfig: vi.fn().mockResolvedValue(err(new Error('persona parse error'))),
        getByName: vi.fn(),
      }) as any);

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to load personas');
      expect(db.close).toHaveBeenCalledOnce();
    });

    it('returns error when skill loading fails and closes db', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as any));
      vi.mocked(createDatabase).mockReturnValue(ok(db as any));
      vi.mocked(runMigrations).mockReturnValue(ok(0));

      // Restore PersonaLoader to success (may have been overridden by previous test).
      vi.mocked(PersonaLoader).mockImplementation(() => ({
        loadFromConfig: vi.fn().mockResolvedValue(ok(undefined)),
        getByName: vi.fn().mockReturnValue(ok({})),
      }) as any);

      // Override the SkillLoader mock to make loadFromPersonaConfig fail.
      vi.mocked(SkillLoader).mockImplementation(() => ({
        loadFromPersonaConfig: vi.fn().mockResolvedValue(err(new Error('skill manifest invalid'))),
      }) as any);

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to load skills');
      expect(db.close).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Successful bootstrap
  // -------------------------------------------------------------------------

  describe('successful bootstrap', () => {
    it('returns Ok(DaemonContext) with all fields populated', async () => {
      setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();

      expect(ctx.db).toBeDefined();
      expect(ctx.config).toBeDefined();
      expect(ctx.configPath).toBe('/config.yaml');
      expect(ctx.dataDir).toBe('/tmp/test-data');
      expect(ctx.repos).toBeDefined();
      expect(ctx.repos.queue).toBeDefined();
      expect(ctx.repos.thread).toBeDefined();
      expect(ctx.repos.channel).toBeDefined();
      expect(ctx.repos.persona).toBeDefined();
      expect(ctx.repos.backgroundTask).toBeDefined();
      expect(ctx.repos.schedule).toBeDefined();
      expect(ctx.repos.audit).toBeDefined();
      expect(ctx.repos.message).toBeDefined();
      expect(ctx.repos.run).toBeDefined();
      expect(ctx.repos.binding).toBeDefined();
      expect(ctx.repos.memory).toBeDefined();
      expect(ctx.channelRegistry).toBeDefined();
      expect(ctx.queueManager).toBeDefined();
      expect(ctx.scheduler).toBeDefined();
      expect(ctx.personaLoader).toBeDefined();
      expect(ctx.sessionTracker).toBeDefined();
      expect(ctx.threadWorkspace).toBeDefined();
      expect(ctx.auditLogger).toBeDefined();
      expect(ctx.skillResolver).toBeDefined();
      expect(ctx.loadedSkills).toBeDefined();
      expect(ctx.hostToolsBridge).toBeDefined();
      expect(ctx.backgroundAgentManager).toBeDefined();
      expect(ctx.providerRegistry).toBeDefined();
      expect(ctx.logger).toBeDefined();
    });

    it('applies the configured log level during bootstrap', async () => {
      setupSuccessfulMocks();
      const configuredLogger = createDiscardLogger('info');
      vi.mocked(loadConfig).mockReturnValue(ok(makeConfig({ logLevel: 'debug' }) as any));

      const result = await bootstrap('/config.yaml', configuredLogger);

      expect(result.isOk()).toBe(true);
      expect(configuredLogger.level).toBe('debug');
    });
    it('calls recoverFromCrash during bootstrap', async () => {
      setupSuccessfulMocks();

      await bootstrap('/config.yaml', logger);

      expect(recoverFromCrash).toHaveBeenCalledOnce();
    });

    it('creates HostToolsBridge and attaches it to context', async () => {
      setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      expect(HostToolsBridge).toHaveBeenCalledOnce();
      // Verify bridge was constructed with the context object.
      expect(HostToolsBridge).toHaveBeenCalledWith(
        expect.objectContaining({ dataDir: '/tmp/test-data' }),
      );
      const ctx = result._unsafeUnwrap();
      expect(ctx.hostToolsBridge).toBeDefined();
    });

    it('constructs background task persistence and background agent manager', async () => {
      setupSuccessfulMocks();

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      expect(BackgroundTaskRepository).toHaveBeenCalledOnce();
      expect(BackgroundAgentManager).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: expect.anything(),
          queueManager: expect.anything(),
          maxConcurrent: 3,
          defaultTimeoutMinutes: 30,
          defaultProvider: 'claude-code',
          providerRegistry: expect.anything(),
        }),
      );
      expect(
        (vi.mocked(BackgroundAgentManager).mock.results[0]?.value as any).recoverOrphanedTasks,
      ).toHaveBeenCalledOnce();
    });

    it('registers gemini-cli when enabled in provider config', async () => {
      setupSuccessfulMocks();
      vi.mocked(loadConfig).mockReturnValue(
        ok(
          makeConfig({
            agentRunner: {
              defaultProvider: 'gemini-cli',
              providers: {
                'claude-code': {
                  enabled: true,
                  command: 'claude',
                  contextWindowTokens: 200000,
                  rotationThreshold: 0.4,
                },
                'gemini-cli': {
                  enabled: true,
                  command: 'gemini',
                  contextWindowTokens: 1000000,
                  rotationThreshold: 0.8,
                  options: {
                    defaultModel: 'gemini-2.5-pro',
                  },
                },
              },
            },
            backgroundAgent: {
              enabled: true,
              maxConcurrent: 3,
              defaultTimeoutMinutes: 30,
              defaultProvider: 'gemini-cli',
              providers: {
                'claude-code': {
                  enabled: true,
                  command: 'claude',
                  contextWindowTokens: 200000,
                  rotationThreshold: 0.4,
                },
                'gemini-cli': {
                  enabled: true,
                  command: 'gemini',
                  contextWindowTokens: 1000000,
                  rotationThreshold: 0.8,
                  options: {
                    defaultModel: 'gemini-2.5-pro',
                  },
                },
              },
            },
          }) as any,
        ),
      );

      const result = await bootstrap('/config.yaml', logger);

      expect(result.isOk()).toBe(true);
      const ctx = result._unsafeUnwrap();
      expect(ctx.providerRegistry.get('gemini-cli')?.provider.name).toBe('gemini-cli');
      expect(ctx.providerRegistry.getDefault(['gemini-cli'])?.provider.name).toBe('gemini-cli');
      expect(BackgroundAgentManager).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: 'gemini-cli',
        }),
      );
    });

    it('calls registerChannels during bootstrap', async () => {
      setupSuccessfulMocks();

      await bootstrap('/config.yaml', logger);

      expect(registerChannels).toHaveBeenCalledOnce();
    });
  });
});
