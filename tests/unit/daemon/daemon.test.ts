/**
 * Unit tests for TalondDaemon lifecycle.
 *
 * All filesystem and SQLite subsystems are mocked via vi.mock() so tests
 * run without touching the disk. State transitions, health reporting, and
 * idempotency behaviours are verified against the mock stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Module-level mocks
//
// Must be declared before any import that triggers the modules being mocked.
// ---------------------------------------------------------------------------

// Mock config loader
vi.mock('../../../src/core/config/config-loader.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock database connection
vi.mock('../../../src/core/database/connection.js', () => ({
  createDatabase: vi.fn(),
}));

// Mock migration runner
vi.mock('../../../src/core/database/migrations/runner.js', () => ({
  runMigrations: vi.fn(),
}));

// Mock lifecycle helpers to avoid real FS operations
vi.mock('../../../src/daemon/lifecycle.js', () => ({
  recoverFromCrash: vi.fn(),
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are declared)
// ---------------------------------------------------------------------------

import { TalondDaemon } from '../../../src/daemon/daemon.js';
import { loadConfig } from '../../../src/core/config/config-loader.js';
import { createDatabase } from '../../../src/core/database/connection.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { recoverFromCrash, writePidFile, removePidFile } from '../../../src/daemon/lifecycle.js';
import { ConfigError, DbError, MigrationError } from '../../../src/core/errors/index.js';

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

/**
 * Creates a mock better-sqlite3 Database object.
 * Returns minimal methods used by repositories and the daemon itself.
 */
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
 * Sets up mocks for a successful daemon startup.
 * Returns the mock DB so callers can inspect it.
 */
function setupSuccessfulStartMocks() {
  const config = makeConfig();
  const db = makeMockDb();

  vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
  vi.mocked(createDatabase).mockReturnValue(ok(db as unknown as import('better-sqlite3').Database));
  vi.mocked(runMigrations).mockReturnValue(ok(1));

  return { config, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TalondDaemon', () => {
  let daemon: TalondDaemon;

  beforeEach(() => {
    daemon = new TalondDaemon(createSilentLogger());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Ensure daemon is stopped after each test to avoid timer leaks.
    if (daemon.state !== 'stopped') {
      await daemon.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in the stopped state', () => {
      expect(daemon.state).toBe('stopped');
    });

    it('health() returns stopped state with zero values', () => {
      const health = daemon.health();
      expect(health.state).toBe('stopped');
      expect(health.uptime).toBe(0);
      expect(health.activeChannels).toEqual([]);
      expect(health.schedulerRunning).toBe(false);
      expect(health.queueStats).toEqual({
        pending: 0,
        claimed: 0,
        processing: 0,
        deadLetter: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Successful startup
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('returns Ok(void) on successful startup', async () => {
      setupSuccessfulStartMocks();

      const result = await daemon.start('/etc/talond/config.yaml');

      expect(result.isOk()).toBe(true);
    });

    it('transitions state to running after successful start', async () => {
      setupSuccessfulStartMocks();

      await daemon.start('/etc/talond/config.yaml');

      expect(daemon.state).toBe('running');
    });

    it('calls loadConfig with the provided path', async () => {
      setupSuccessfulStartMocks();

      await daemon.start('/custom/path.yaml');

      expect(loadConfig).toHaveBeenCalledWith('/custom/path.yaml');
    });

    it('calls createDatabase with the storage path from config', async () => {
      const config = makeConfig({ storage: { type: 'sqlite', path: '/var/lib/talond.db' } });
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
      vi.mocked(createDatabase).mockReturnValue(ok(db as unknown as import('better-sqlite3').Database));
      vi.mocked(runMigrations).mockReturnValue(ok(0));

      await daemon.start('/config.yaml');

      expect(createDatabase).toHaveBeenCalledWith('/var/lib/talond.db');
    });

    it('calls runMigrations after opening the database', async () => {
      setupSuccessfulStartMocks();

      await daemon.start('/config.yaml');

      expect(runMigrations).toHaveBeenCalledOnce();
    });

    it('calls recoverFromCrash after creating repositories', async () => {
      setupSuccessfulStartMocks();

      await daemon.start('/config.yaml');

      expect(recoverFromCrash).toHaveBeenCalledOnce();
    });

    it('writes the PID file on successful start', async () => {
      setupSuccessfulStartMocks();

      await daemon.start('/config.yaml');

      expect(writePidFile).toHaveBeenCalledWith('/tmp/test-data');
    });

    it('health() shows running state and positive uptime after start', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      const health = daemon.health();
      expect(health.state).toBe('running');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.schedulerRunning).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Startup failure scenarios
  // -------------------------------------------------------------------------

  describe('start() failure scenarios', () => {
    it('returns Err(DaemonError) when config fails to load', async () => {
      vi.mocked(loadConfig).mockReturnValue(
        err(new ConfigError('config file not found')),
      );

      const result = await daemon.start('/missing.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
      expect(result._unsafeUnwrapErr().message).toContain('config file not found');
    });

    it('transitions state to error when config loading fails', async () => {
      vi.mocked(loadConfig).mockReturnValue(
        err(new ConfigError('invalid config')),
      );

      await daemon.start('/bad.yaml');

      expect(daemon.state).toBe('error');
    });

    it('returns Err(DaemonError) when database cannot be opened', async () => {
      const config = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
      vi.mocked(createDatabase).mockReturnValue(
        err(new DbError('cannot open database')),
      );

      const result = await daemon.start('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('transitions state to error when database fails to open', async () => {
      const config = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
      vi.mocked(createDatabase).mockReturnValue(
        err(new DbError('cannot open database')),
      );

      await daemon.start('/config.yaml');

      expect(daemon.state).toBe('error');
    });

    it('returns Err(DaemonError) when migrations fail', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
      vi.mocked(createDatabase).mockReturnValue(ok(db as unknown as import('better-sqlite3').Database));
      vi.mocked(runMigrations).mockReturnValue(
        err(new MigrationError('migration 001 failed')),
      );

      const result = await daemon.start('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('closes the database if migrations fail', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
      vi.mocked(createDatabase).mockReturnValue(ok(db as unknown as import('better-sqlite3').Database));
      vi.mocked(runMigrations).mockReturnValue(
        err(new MigrationError('migration failed')),
      );

      await daemon.start('/config.yaml');

      expect(db.close).toHaveBeenCalledOnce();
    });

    it('transitions state to error when migrations fail', async () => {
      const config = makeConfig();
      const db = makeMockDb();
      vi.mocked(loadConfig).mockReturnValue(ok(config as Parameters<typeof loadConfig>[0]));
      vi.mocked(createDatabase).mockReturnValue(ok(db as unknown as import('better-sqlite3').Database));
      vi.mocked(runMigrations).mockReturnValue(
        err(new MigrationError('migration failed')),
      );

      await daemon.start('/config.yaml');

      expect(daemon.state).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // Double-start idempotency
  // -------------------------------------------------------------------------

  describe('double-start idempotency', () => {
    it('returns Err(DaemonError) if start() is called while already running', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      // Second call — should fail without calling loadConfig again
      const result = await daemon.start('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('does not change state on a rejected second start', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      await daemon.start('/config.yaml');

      // Should still be running from the first start
      expect(daemon.state).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('transitions state to stopped after shutdown', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(daemon.state).toBe('stopped');
    });

    it('closes the database during shutdown', async () => {
      const { db } = setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(db.close).toHaveBeenCalledOnce();
    });

    it('removes the PID file during shutdown', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      await daemon.stop();

      expect(removePidFile).toHaveBeenCalledWith('/tmp/test-data');
    });

    it('health() shows stopped state after stop()', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');
      await daemon.stop();

      const health = daemon.health();
      expect(health.state).toBe('stopped');
    });

    it('health() reports uptime 0 after stop()', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');
      await daemon.stop();

      expect(daemon.health().uptime).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Double-stop idempotency
  // -------------------------------------------------------------------------

  describe('double-stop idempotency', () => {
    it('is safe to call stop() twice', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      await daemon.stop();
      // Second call should be a no-op
      await expect(daemon.stop()).resolves.not.toThrow();
    });

    it('database is closed only once on double-stop', async () => {
      const { db } = setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      await daemon.stop();
      await daemon.stop();

      expect(db.close).toHaveBeenCalledOnce();
    });

    it('is safe to call stop() on a daemon that was never started', async () => {
      await expect(daemon.stop()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Health reporting
  // -------------------------------------------------------------------------

  describe('health()', () => {
    it('reports schedulerRunning=false before start', () => {
      expect(daemon.health().schedulerRunning).toBe(false);
    });

    it('reports schedulerRunning=true while running', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      expect(daemon.health().schedulerRunning).toBe(true);
    });

    it('reports schedulerRunning=false after stop', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');
      await daemon.stop();

      expect(daemon.health().schedulerRunning).toBe(false);
    });

    it('reports activeChannels as empty when no connectors are registered', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      expect(daemon.health().activeChannels).toEqual([]);
    });

    it('reports queueStats from the queue manager', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      const health = daemon.health();
      // With a mock DB returning no rows, all counts are 0
      expect(health.queueStats.pending).toBeGreaterThanOrEqual(0);
      expect(health.queueStats.deadLetter).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------

  describe('reload()', () => {
    it('returns Err(DaemonError) if called when not running', async () => {
      const result = await daemon.reload('/config.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('returns Ok when daemon is running and configPath is provided', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/original.yaml');

      // Re-mock loadConfig for the reload call
      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));

      const result = await daemon.reload('/updated.yaml');

      expect(result.isOk()).toBe(true);
    });

    it('returns Ok when configPath is omitted', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      const result = await daemon.reload();

      expect(result.isOk()).toBe(true);
    });

    it('returns Err if reload config fails to load', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      vi.mocked(loadConfig).mockReturnValue(
        err(new ConfigError('bad reload config')),
      );

      const result = await daemon.reload('/bad.yaml');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DAEMON_ERROR');
    });

    it('does not change daemon state on reload', async () => {
      setupSuccessfulStartMocks();
      await daemon.start('/config.yaml');

      const newConfig = makeConfig();
      vi.mocked(loadConfig).mockReturnValue(ok(newConfig as Parameters<typeof loadConfig>[0]));
      await daemon.reload('/updated.yaml');

      expect(daemon.state).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // PID file failure tolerance
  // -------------------------------------------------------------------------

  describe('PID file failure tolerance', () => {
    it('continues startup even if writePidFile throws', async () => {
      setupSuccessfulStartMocks();
      vi.mocked(writePidFile).mockImplementation(() => {
        throw new Error('disk full');
      });

      const result = await daemon.start('/config.yaml');

      // Daemon should still reach running state despite PID file failure
      expect(result.isOk()).toBe(true);
      expect(daemon.state).toBe('running');
    });
  });
});
