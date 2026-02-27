/**
 * Unit tests for TalondDaemon hot-reload behaviour.
 *
 * All subsystems are mocked so tests run without touching the disk.
 * Focus is on config-diff detection and correct log output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';

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

vi.mock('../../../src/daemon/lifecycle.js', () => ({
  recoverFromCrash: vi.fn(),
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
}));

// Mock watchdog to avoid touching the filesystem during these tests
vi.mock('../../../src/daemon/watchdog.js', () => ({
  WatchdogNotifier: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    notifyReady: vi.fn(),
    notifyStopping: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TalondDaemon } from '../../../src/daemon/daemon.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { createDatabase } from '../../../src/core/database/connection.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { ConfigError } from '../../../src/core/errors/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
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

function setupSuccessfulStartMocks(configOverrides: Record<string, unknown> = {}) {
  const config = makeConfig(configOverrides);
  const db = makeMockDb();
  vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
  vi.mocked(createDatabase).mockReturnValue(ok(db as unknown as import('better-sqlite3').Database));
  vi.mocked(runMigrations).mockReturnValue(ok(1));
  return { config, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TalondDaemon.reload()', () => {
  let daemon: TalondDaemon;

  beforeEach(() => {
    daemon = new TalondDaemon(createSilentLogger());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (daemon.state !== 'stopped') {
      await daemon.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Guard conditions
  // -------------------------------------------------------------------------

  describe('guard conditions', () => {
    it('returns Err(DaemonError) when daemon is not running', async () => {
      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('error message mentions current state', async () => {
      const result = await daemon.reload('/config.yaml');

      expect(result._unsafeUnwrapErr().message).toContain('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // Config path resolution
  // -------------------------------------------------------------------------

  describe('config path resolution', () => {
    it('uses the provided configPath when given', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/original.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await daemon.reload('/updated.yaml');

      expect(loadConfig).toHaveBeenCalledWith('/updated.yaml');
    });

    it('falls back to the startup configPath when no argument given', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/startup.yaml');

      const newConfig = makeConfig();
      // loadConfig is called once for start(), reset count before reload
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await daemon.reload(); // no argument

      expect(loadConfig).toHaveBeenCalledWith('/startup.yaml');
    });

    it('returns Ok when configPath is omitted and startup path is known', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      const result = await daemon.reload();

      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Config load failure
  // -------------------------------------------------------------------------

  describe('config load failure', () => {
    it('returns Err(DaemonError) when config re-read fails', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(err(new ConfigError('file not found')));

      const result = await daemon.reload('/bad.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('error wraps the underlying ConfigError message', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(err(new ConfigError('YAML syntax error')));

      const result = await daemon.reload('/bad.yaml');

      expect(result._unsafeUnwrapErr().message).toContain('YAML syntax error');
    });

    it('does not change daemon state on config load failure', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(err(new ConfigError('fail')));
      await daemon.reload('/bad.yaml');

      expect(daemon.state).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // Log level changes
  // -------------------------------------------------------------------------

  describe('log level changes', () => {
    it('updates logger level when logLevel changes', async () => {
      setupSuccessfulStartMocks({ logLevel: 'info' });
      const logger = pino({ level: 'silent' });
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ logLevel: 'debug' });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      expect(logger.level).toBe('debug');

      await localDaemon.stop();
    });

    it('does not change logger level when logLevel is unchanged', async () => {
      setupSuccessfulStartMocks({ logLevel: 'info' });
      const logger = pino({ level: 'silent' });
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      // logger.level is 'silent' (the pino creation level) — daemon does not
      // apply the config log level during start, only on reload.
      // Record current level before reload.
      const levelBeforeReload = logger.level;

      const newConfig = makeConfig({ logLevel: 'info' });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      // The new config logLevel ('info') differs from the logger's actual level
      // ('silent'), but the daemon compares newConfig.logLevel against
      // currentConfig.logLevel (both are 'info' here), so it does NOT update
      // the logger. Level should remain unchanged.
      expect(logger.level).toBe(levelBeforeReload);

      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Channel diff logging
  // -------------------------------------------------------------------------

  describe('channel diff logging', () => {
    it('logs added channels', async () => {
      setupSuccessfulStartMocks({ channels: [] });
      const logger = pino({ level: 'silent' });
      const logSpy = vi.spyOn(logger, 'info');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({
        channels: [{ type: 'telegram', name: 'my-telegram', config: {}, enabled: true }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      // Check that a log message about added channels was emitted
      const calls = logSpy.mock.calls;
      const addedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'added' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).added) &&
          ((args[0] as Record<string, unknown>).added as string[]).includes('my-telegram'),
      );
      expect(addedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs removed channels', async () => {
      setupSuccessfulStartMocks({
        channels: [{ type: 'telegram', name: 'old-channel', config: {}, enabled: true }],
      });
      const logger = pino({ level: 'silent' });
      const logSpy = vi.spyOn(logger, 'info');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ channels: [] });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const removedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'removed' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).removed) &&
          ((args[0] as Record<string, unknown>).removed as string[]).includes('old-channel'),
      );
      expect(removedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('does not log channel changes when channels are identical', async () => {
      const channels = [{ type: 'telegram', name: 'stable', config: {}, enabled: true }];
      setupSuccessfulStartMocks({ channels });
      const logger = pino({ level: 'silent' });
      const logSpy = vi.spyOn(logger, 'info');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ channels });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const channelDiffLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          ('added' in (args[0] as Record<string, unknown>) ||
            'removed' in (args[0] as Record<string, unknown>)),
      );
      expect(channelDiffLog).toBeUndefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Persona diff logging
  // -------------------------------------------------------------------------

  describe('persona diff logging', () => {
    it('logs added personas', async () => {
      setupSuccessfulStartMocks({ personas: [] });
      const logger = pino({ level: 'silent' });
      const logSpy = vi.spyOn(logger, 'info');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({
        personas: [{ name: 'new-bot', model: 'claude-sonnet-4-6', skills: [], capabilities: { allow: [], requireApproval: [] }, mounts: [] }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const addedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'added' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).added) &&
          ((args[0] as Record<string, unknown>).added as string[]).includes('new-bot'),
      );
      expect(addedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs removed personas', async () => {
      setupSuccessfulStartMocks({
        personas: [{ name: 'old-bot', model: 'claude-sonnet-4-6', skills: [], capabilities: { allow: [], requireApproval: [] }, mounts: [] }],
      });
      const logger = pino({ level: 'silent' });
      const logSpy = vi.spyOn(logger, 'info');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ personas: [] });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const removedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'removed' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).removed) &&
          ((args[0] as Record<string, unknown>).removed as string[]).includes('old-bot'),
      );
      expect(removedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs changed personas', async () => {
      const persona = { name: 'agent', model: 'claude-sonnet-4-6', skills: [], capabilities: { allow: [], requireApproval: [] }, mounts: [] };
      setupSuccessfulStartMocks({ personas: [persona] });
      const logger = pino({ level: 'silent' });
      const logSpy = vi.spyOn(logger, 'info');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({
        personas: [{ ...persona, model: 'claude-opus-4-6' }],
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const calls = logSpy.mock.calls;
      const changedLog = calls.find(
        (args) =>
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'changed' in (args[0] as Record<string, unknown>) &&
          Array.isArray((args[0] as Record<string, unknown>).changed) &&
          ((args[0] as Record<string, unknown>).changed as string[]).includes('agent'),
      );
      expect(changedLog).toBeDefined();

      logSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Queue / scheduler config changes
  // -------------------------------------------------------------------------

  describe('queue / scheduler config changes', () => {
    it('logs a warning when queue config changes', async () => {
      setupSuccessfulStartMocks({ queue: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 } });
      const logger = pino({ level: 'silent' });
      const warnSpy = vi.spyOn(logger, 'warn');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ queue: { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 2 } });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const warnCalls = warnSpy.mock.calls;
      const queueWarn = warnCalls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('queue config'),
      );
      expect(queueWarn).toBeDefined();

      warnSpy.mockRestore();
      await localDaemon.stop();
    });

    it('logs a warning when scheduler config changes', async () => {
      setupSuccessfulStartMocks({ scheduler: { tickIntervalMs: 5000 } });
      const logger = pino({ level: 'silent' });
      const warnSpy = vi.spyOn(logger, 'warn');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({ scheduler: { tickIntervalMs: 10000 } });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const warnCalls = warnSpy.mock.calls;
      const schedulerWarn = warnCalls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('scheduler config'),
      );
      expect(schedulerWarn).toBeDefined();

      warnSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Container image changes
  // -------------------------------------------------------------------------

  describe('container image changes', () => {
    it('logs a warning when the sandbox image changes', async () => {
      setupSuccessfulStartMocks({
        sandbox: {
          runtime: 'docker',
          image: 'talon-sandbox:v1',
          maxConcurrent: 3,
          networkDefault: 'off',
          idleTimeoutMs: 1800000,
          hardTimeoutMs: 3600000,
          resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
        },
      });
      const logger = pino({ level: 'silent' });
      const warnSpy = vi.spyOn(logger, 'warn');
      const localDaemon = new TalondDaemon(logger);
      await localDaemon.start('/config.yaml');

      const newConfig = makeConfig({
        sandbox: {
          runtime: 'docker',
          image: 'talon-sandbox:v2',
          maxConcurrent: 3,
          networkDefault: 'off',
          idleTimeoutMs: 1800000,
          hardTimeoutMs: 3600000,
          resourceLimits: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
        },
      });
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await localDaemon.reload('/config.yaml');

      const warnCalls = warnSpy.mock.calls;
      const imageWarn = warnCalls.find((args) => {
        if (typeof args[0] === 'object' && args[0] !== null) {
          const obj = args[0] as Record<string, unknown>;
          return 'from' in obj && 'to' in obj;
        }
        if (typeof args[1] === 'string') {
          return args[1].includes('container image');
        }
        return false;
      });
      expect(imageWarn).toBeDefined();

      warnSpy.mockRestore();
      await localDaemon.stop();
    });
  });

  // -------------------------------------------------------------------------
  // State invariants
  // -------------------------------------------------------------------------

  describe('state invariants', () => {
    it('daemon remains in running state after successful reload', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      await daemon.reload('/config.yaml');

      expect(daemon.state).toBe('running');
    });

    it('successive reloads are all successful', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      for (let i = 0; i < 3; i++) {
        const newConfig = makeConfig({ logLevel: i % 2 === 0 ? 'info' : 'debug' });
        vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

        const result = await daemon.reload('/config.yaml');
        expect(result.isOk()).toBe(true);
      }
    });
  });
});
