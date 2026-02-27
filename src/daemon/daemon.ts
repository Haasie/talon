/**
 * TalondDaemon — central orchestrator for the talond autonomous agent daemon.
 *
 * Initialises all subsystems in dependency order on `start()`, tears them
 * down gracefully on `stop()`, and exposes a health snapshot at any time
 * via `health()`.
 *
 * Design principles:
 * - All subsystem instances are created inside `start()`, never in the
 *   constructor, so a single daemon object can be started/stopped in tests.
 * - Startup failures propagate as neverthrow Result errors; shutdown is
 *   best-effort (void return, errors are logged and swallowed).
 * - Channel start failures are non-fatal: the daemon continues without
 *   channels so the queue and scheduler still operate.
 */

import { join } from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import type Database from 'better-sqlite3';

import { loadConfig } from '../core/config/config-loader.js';
import { createDatabase } from '../core/database/connection.js';
import { runMigrations } from '../core/database/migrations/runner.js';

import {
  QueueRepository,
  ThreadRepository,
  ChannelRepository,
  PersonaRepository,
  ScheduleRepository,
  AuditRepository,
  MessageRepository,
  RunRepository,
  MemoryRepository,
  ArtifactRepository,
  BindingRepository,
  ToolResultRepository,
} from '../core/database/repositories/index.js';

import { ChannelRegistry } from '../channels/channel-registry.js';
import { QueueManager } from '../queue/queue-manager.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { DaemonError } from '../core/errors/error-types.js';

import { recoverFromCrash, writePidFile, removePidFile } from './lifecycle.js';
import type { DaemonState, DaemonHealth } from './daemon-types.js';

// TODO: Wire up SandboxManager when sandbox integration task is complete.
// TODO: Wire up PersonaLoader when persona management task is complete.
// TODO: Wire up SkillLoader when skill loading task is complete.
// TODO: Wire up McpProxy when MCP integration task is complete.
// TODO: Wire up DaemonIpc when IPC task is complete.

// ---------------------------------------------------------------------------
// TalondDaemon
// ---------------------------------------------------------------------------

/**
 * Main daemon class.
 *
 * Usage:
 * ```ts
 * const daemon = new TalondDaemon(logger);
 * const result = await daemon.start('/etc/talond/config.yaml');
 * if (result.isErr()) process.exit(1);
 * ```
 */
export class TalondDaemon {
  private _state: DaemonState = 'stopped';
  private startedAt: number | null = null;

  // Subsystem references — populated during start(), cleared during stop().
  private db: Database.Database | null = null;
  private channelRegistry: ChannelRegistry | null = null;
  private queueManager: QueueManager | null = null;
  private scheduler: Scheduler | null = null;
  private dataDir: string = 'data';

  constructor(private readonly logger: pino.Logger) {}

  // ---------------------------------------------------------------------------
  // State getter
  // ---------------------------------------------------------------------------

  /** Current daemon lifecycle state. */
  get state(): DaemonState {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * Initialises all subsystems and starts the daemon.
   *
   * Steps:
   * 1. Load and validate YAML config
   * 2. Open SQLite database
   * 3. Run pending migrations
   * 4. Create all repositories
   * 5. Recover from any previous crash (reset in-flight queue items)
   * 6. Initialise channel registry
   * 7. Initialise queue manager
   * 8. Initialise scheduler
   * 9. Start channel connectors (non-fatal on failure)
   * 10. Start queue processing loop
   * 11. Start scheduler tick loop
   * 12. Write PID file
   * 13. Mark state as 'running'
   *
   * @param configPath - Absolute or relative path to the YAML config file.
   * @returns Ok(void) on success, Err(DaemonError) on unrecoverable failure.
   */
  async start(configPath: string): Promise<Result<void, DaemonError>> {
    if (this._state !== 'stopped') {
      return err(
        new DaemonError(`Cannot start daemon in state '${this._state}' (expected 'stopped')`),
      );
    }

    this._state = 'starting';
    this.logger.info({ configPath }, 'daemon: starting');

    // ------------------------------------------------------------------
    // 1. Load config
    // ------------------------------------------------------------------
    const configResult = loadConfig(configPath);
    if (configResult.isErr()) {
      this._state = 'error';
      return err(
        new DaemonError(
          `Failed to load config: ${configResult.error.message}`,
          configResult.error,
        ),
      );
    }
    const config = configResult.value;
    this.dataDir = config.dataDir;
    this.logger.info({ logLevel: config.logLevel }, 'daemon: config loaded');

    // ------------------------------------------------------------------
    // 2. Open database
    // ------------------------------------------------------------------
    const dbResult = createDatabase(config.storage.path);
    if (dbResult.isErr()) {
      this._state = 'error';
      return err(
        new DaemonError(
          `Failed to open database: ${dbResult.error.message}`,
          dbResult.error,
        ),
      );
    }
    this.db = dbResult.value;

    // ------------------------------------------------------------------
    // 3. Run migrations
    // ------------------------------------------------------------------
    const migrationsDir = join(import.meta.dirname, '../core/database/migrations');
    const migrationsResult = runMigrations(this.db, migrationsDir);
    if (migrationsResult.isErr()) {
      this._state = 'error';
      this.db.close();
      this.db = null;
      return err(
        new DaemonError(
          `Failed to run migrations: ${migrationsResult.error.message}`,
          migrationsResult.error,
        ),
      );
    }
    this.logger.info({ applied: migrationsResult.value }, 'daemon: migrations complete');

    // ------------------------------------------------------------------
    // 4. Create repositories
    // ------------------------------------------------------------------
    const queueRepo = new QueueRepository(this.db);
    const threadRepo = new ThreadRepository(this.db);
    const channelRepo = new ChannelRepository(this.db);
    const personaRepo = new PersonaRepository(this.db);
    const scheduleRepo = new ScheduleRepository(this.db);
    new AuditRepository(this.db);
    new MessageRepository(this.db);
    new RunRepository(this.db);
    new MemoryRepository(this.db);
    new ArtifactRepository(this.db);
    new BindingRepository(this.db);
    new ToolResultRepository(this.db);

    // Suppress unused-variable warnings for repositories that will be used by
    // future subsystems (PersonaLoader, SandboxManager, etc.).
    void channelRepo;
    void personaRepo;

    // ------------------------------------------------------------------
    // 5. Crash recovery
    // ------------------------------------------------------------------
    recoverFromCrash(queueRepo, this.logger);

    // ------------------------------------------------------------------
    // 6. Initialise channel registry
    //    Connectors are registered here; actual start happens in step 9.
    //    TODO: register connectors from config when connector factories exist.
    // ------------------------------------------------------------------
    this.channelRegistry = new ChannelRegistry(this.logger);

    // ------------------------------------------------------------------
    // 7. Initialise queue manager
    // ------------------------------------------------------------------
    this.queueManager = new QueueManager(queueRepo, threadRepo, config.queue, this.logger);

    // ------------------------------------------------------------------
    // 8. Initialise scheduler
    // ------------------------------------------------------------------
    this.scheduler = new Scheduler(scheduleRepo, this.queueManager, config.scheduler, this.logger);

    // ------------------------------------------------------------------
    // 9. Start channel connectors (non-fatal: log and continue)
    // ------------------------------------------------------------------
    try {
      await this.channelRegistry.startAll();
      this.logger.info('daemon: all channel connectors started');
    } catch (cause) {
      this.logger.error(
        { cause },
        'daemon: one or more channel connectors failed to start — continuing without them',
      );
    }

    // ------------------------------------------------------------------
    // 10. Start queue processing loop
    //     The handler is a no-op placeholder; real dispatch logic arrives
    //     when the agent runner task is implemented.
    //
    //     TODO: replace no-op handler with actual agent dispatch.
    // ------------------------------------------------------------------
    this.queueManager.startProcessing(async (_item) => {
      // TODO: dispatch item to the appropriate persona/agent runner.
      return ok(undefined);
    });

    // ------------------------------------------------------------------
    // 11. Start scheduler
    // ------------------------------------------------------------------
    this.scheduler.start();

    // ------------------------------------------------------------------
    // 12. Write PID file
    // ------------------------------------------------------------------
    try {
      writePidFile(this.dataDir);
    } catch (cause) {
      // PID file failure is non-fatal; log and continue.
      this.logger.warn({ cause }, 'daemon: failed to write PID file');
    }

    // ------------------------------------------------------------------
    // 13. Mark running
    // ------------------------------------------------------------------
    this._state = 'running';
    this.startedAt = Date.now();
    this.logger.info('daemon: running');

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shuts down all subsystems.
   *
   * Shutdown order (reverse of startup):
   * 1. Set state to 'stopping'
   * 2. Stop channel connectors (no new inbound messages)
   * 3. Stop scheduler (no new jobs enqueued)
   * 4. Stop queue processing loop
   * 5. Close database
   * 6. Remove PID file
   * 7. Set state to 'stopped'
   *
   * Errors during shutdown are logged but do not interrupt the sequence.
   */
  async stop(): Promise<void> {
    if (this._state === 'stopped' || this._state === 'stopping') {
      return;
    }

    this._state = 'stopping';
    this.logger.info('daemon: stopping');

    // 1. Stop channel connectors
    if (this.channelRegistry !== null) {
      try {
        await this.channelRegistry.stopAll();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error stopping channel connectors');
      }
      this.channelRegistry = null;
    }

    // 2. Stop scheduler
    if (this.scheduler !== null) {
      this.scheduler.stop();
      this.scheduler = null;
    }

    // 3. Stop queue processing
    if (this.queueManager !== null) {
      this.queueManager.stopProcessing();
      this.queueManager = null;
    }

    // 4. Close database
    if (this.db !== null) {
      try {
        this.db.close();
      } catch (cause) {
        this.logger.error({ cause }, 'daemon: error closing database');
      }
      this.db = null;
    }

    // 5. Remove PID file
    try {
      removePidFile(this.dataDir);
    } catch (cause) {
      this.logger.warn({ cause }, 'daemon: failed to remove PID file');
    }

    this._state = 'stopped';
    this.startedAt = null;
    this.logger.info('daemon: stopped');
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /**
   * Returns a point-in-time health snapshot.
   *
   * Computed from in-memory state — no database queries are performed.
   * Safe to call from any state, including 'stopped'.
   */
  health(): DaemonHealth {
    const queueStats =
      this.queueManager !== null
        ? this.queueManager.stats()
        : { pending: 0, claimed: 0, processing: 0, deadLetter: 0 };

    const activeChannels =
      this.channelRegistry !== null
        ? this.channelRegistry.listAll().map((c) => c.name)
        : [];

    const uptime =
      this._state === 'running' && this.startedAt !== null ? Date.now() - this.startedAt : 0;

    return {
      state: this._state,
      uptime,
      queueStats,
      activeChannels,
      schedulerRunning: this.scheduler !== null,
    };
  }

  // ---------------------------------------------------------------------------
  // Reload
  // ---------------------------------------------------------------------------

  /**
   * Placeholder for hot-reload support.
   *
   * Re-reads and logs the config but does not restart subsystems.
   * Full hot-reload (re-registering connectors, updating schedules) is a
   * future task.
   *
   * @param configPath - Path to reload the config from.
   *                     Defaults to the path used at startup if omitted.
   */
  async reload(configPath?: string): Promise<Result<void, DaemonError>> {
    if (this._state !== 'running') {
      return err(
        new DaemonError(
          `Cannot reload daemon in state '${this._state}' (expected 'running')`,
        ),
      );
    }

    if (!configPath) {
      // TODO: persist the original configPath on start() and use it here.
      this.logger.info('daemon: reload requested but no configPath provided — skipping');
      return ok(undefined);
    }

    const configResult = loadConfig(configPath);
    if (configResult.isErr()) {
      return err(
        new DaemonError(
          `Failed to reload config: ${configResult.error.message}`,
          configResult.error,
        ),
      );
    }

    // TODO: apply hot-reload changes (update log level, re-register channels, etc.)
    this.logger.info('daemon: config reloaded (hot-reload not yet implemented)');
    return ok(undefined);
  }
}
