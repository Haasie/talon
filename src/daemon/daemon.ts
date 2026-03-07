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
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
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
import { ChannelRouter } from '../channels/channel-router.js';
import type { ChannelConnector, InboundEvent } from '../channels/channel-types.js';
import { TelegramConnector } from '../channels/connectors/telegram/telegram-connector.js';
import type { TelegramConfig } from '../channels/connectors/telegram/telegram-types.js';
import { SlackConnector } from '../channels/connectors/slack/slack-connector.js';
import type { SlackConfig } from '../channels/connectors/slack/slack-types.js';
import { DiscordConnector } from '../channels/connectors/discord/discord-connector.js';
import type { DiscordConfig } from '../channels/connectors/discord/discord-types.js';
import { WhatsAppConnector } from '../channels/connectors/whatsapp/whatsapp-connector.js';
import type { WhatsAppConfig } from '../channels/connectors/whatsapp/whatsapp-types.js';
import { EmailConnector } from '../channels/connectors/email/email-connector.js';
import type { EmailConfig } from '../channels/connectors/email/email-types.js';
import { MessagePipeline } from '../pipeline/message-pipeline.js';
import { QueueManager } from '../queue/queue-manager.js';
import type { QueueItem } from '../queue/queue-types.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { DaemonError } from '../core/errors/error-types.js';
import { AuditLogger, type AuditEntry, type AuditStore } from '../core/logging/audit-logger.js';
import { PersonaLoader } from '../personas/persona-loader.js';
import { SkillLoader } from '../skills/skill-loader.js';
import { SkillResolver } from '../skills/skill-resolver.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import { ThreadWorkspace } from '../memory/thread-workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { ContainerFactory } from '../sandbox/container-factory.js';
import { SdkProcessSpawner } from '../sandbox/sdk-process-spawner.js';
import { SessionTracker } from '../sandbox/session-tracker.js';
import { McpRegistry } from '../mcp/mcp-registry.js';
import { McpProxy } from '../mcp/mcp-proxy.js';

import { recoverFromCrash, writePidFile, removePidFile } from './lifecycle.js';
import { WatchdogNotifier } from './watchdog.js';
import type { DaemonState, DaemonHealth } from './daemon-types.js';
import { DaemonIpcServer } from '../ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../ipc/daemon-ipc.js';
import type { TalondConfig } from '../core/config/config-types.js';

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
  private ipcServer: DaemonIpcServer | null = null;
  private watchdog: WatchdogNotifier | null = null;
  private dataDir: string = 'data';
  private threadWorkspace: ThreadWorkspace | null = null;

  // Repositories required across lifecycle methods.
  private threadRepo: ThreadRepository | null = null;
  private channelRepo: ChannelRepository | null = null;
  private personaRepo: PersonaRepository | null = null;
  private queueRepo: QueueRepository | null = null;
  private runRepo: RunRepository | null = null;
  private messageRepo: MessageRepository | null = null;
  private bindingRepo: BindingRepository | null = null;

  // Orchestration subsystems.
  private auditLogger: AuditLogger | null = null;
  private messagePipeline: MessagePipeline | null = null;
  private personaLoader: PersonaLoader | null = null;
  private skillLoader: SkillLoader | null = null;
  private skillResolver: SkillResolver | null = null;
  private loadedSkills: LoadedSkill[] = [];

  // Sandbox and MCP integrations.
  private sandboxManager: SandboxManager | null = null;
  private sdkProcessSpawner: SdkProcessSpawner | null = null;
  private sessionTracker: SessionTracker | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private mcpProxy: McpProxy | null = null;

  /** Path used to load the config at start-time; re-used by reload(). */
  private configPath: string | null = null;

  /** Active config snapshot; updated on successful reload(). */
  private currentConfig: TalondConfig | null = null;

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
   * 13. Start IPC server
   * 14. Mark state as 'running'
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
    this.configPath = configPath;
    this.logger.info({ configPath }, 'daemon: starting');

    // ------------------------------------------------------------------
    // 1. Load config
    // ------------------------------------------------------------------
    const configResult = loadConfig(configPath);
    if (configResult.isErr()) {
      this._state = 'error';
      return err(
        new DaemonError(`Failed to load config: ${configResult.error.message}`, configResult.error),
      );
    }
    const config = configResult.value;
    this.dataDir = config.dataDir;
    this.currentConfig = config;
    this.logger.info({ logLevel: config.logLevel }, 'daemon: config loaded');

    // ------------------------------------------------------------------
    // 2. Open database
    // ------------------------------------------------------------------
    const dbResult = createDatabase(config.storage.path);
    if (dbResult.isErr()) {
      this._state = 'error';
      return err(
        new DaemonError(`Failed to open database: ${dbResult.error.message}`, dbResult.error),
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
    const auditRepo = new AuditRepository(this.db);
    const messageRepo = new MessageRepository(this.db);
    const runRepo = new RunRepository(this.db);
    new MemoryRepository(this.db);
    new ArtifactRepository(this.db);
    const bindingRepo = new BindingRepository(this.db);
    new ToolResultRepository(this.db);

    this.queueRepo = queueRepo;
    this.threadRepo = threadRepo;
    this.channelRepo = channelRepo;
    this.personaRepo = personaRepo;
    this.runRepo = runRepo;
    this.messageRepo = messageRepo;
    this.bindingRepo = bindingRepo;

    const auditStore = new RepositoryAuditStore(auditRepo);
    this.auditLogger = new AuditLogger(this.logger, auditStore);

    this.threadWorkspace = new ThreadWorkspace(this.dataDir);
    this.personaLoader = new PersonaLoader(personaRepo, this.logger);
    this.skillLoader = new SkillLoader(this.logger);
    this.skillResolver = new SkillResolver(this.logger);

    const personaLoadResult = await this.personaLoader.loadFromConfig(config.personas);
    if (personaLoadResult.isErr()) {
      this._state = 'error';
      this.db.close();
      this.db = null;
      return err(
        new DaemonError(
          `Failed to load personas: ${personaLoadResult.error.message}`,
          personaLoadResult.error,
        ),
      );
    }

    const uniqueSkillNames = new Set<string>();
    for (const persona of config.personas) {
      for (const skill of persona.skills) {
        uniqueSkillNames.add(skill);
      }
    }

    const skillDirs: string[] = [];
    for (const skillName of uniqueSkillNames) {
      const candidates = [
        join(process.cwd(), 'skills', skillName),
        join(this.dataDir, 'skills', skillName),
      ];
      let foundPath: string | null = null;
      for (const candidate of candidates) {
        try {
          await access(candidate, fsConstants.R_OK);
          foundPath = candidate;
          break;
        } catch {
          continue;
        }
      }
      if (foundPath !== null) {
        skillDirs.push(foundPath);
      } else {
        this.logger.warn({ skillName }, 'daemon: skill directory not found; skipping');
      }
    }

    if (skillDirs.length > 0) {
      const skillsResult = await this.skillLoader.loadMultiple(skillDirs);
      if (skillsResult.isErr()) {
        this._state = 'error';
        this.db.close();
        this.db = null;
        return err(
          new DaemonError(
            `Failed to load skills: ${skillsResult.error.message}`,
            skillsResult.error,
          ),
        );
      }
      this.loadedSkills = skillsResult.value;
    }

    this.mcpRegistry = new McpRegistry(this.logger);
    for (const skill of this.loadedSkills) {
      for (const server of skill.resolvedMcpServers) {
        try {
          this.mcpRegistry.register(server.name, server.config);
        } catch (cause) {
          this.logger.warn(
            { mcpServer: server.name, cause: String(cause) },
            'daemon: failed to register MCP server definition',
          );
        }
      }
    }
    await this.mcpRegistry.startAll();
    this.mcpProxy = new McpProxy(this.mcpRegistry, this.logger);

    const containerFactory = new ContainerFactory();
    this.sandboxManager = new SandboxManager(
      containerFactory,
      config.sandbox,
      this.dataDir,
      this.logger,
    );
    this.sdkProcessSpawner = new SdkProcessSpawner(containerFactory.getDocker(), this.logger);
    this.sessionTracker = new SessionTracker();

    // ------------------------------------------------------------------
    // 5. Crash recovery
    // ------------------------------------------------------------------
    recoverFromCrash(queueRepo, this.logger);

    // ------------------------------------------------------------------
    // 6. Initialise channel registry.
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
    // 8b. Initialise message pipeline and register connectors.
    // ------------------------------------------------------------------
    const router = new ChannelRouter(bindingRepo, this.logger);
    this.messagePipeline = new MessagePipeline(
      messageRepo,
      threadRepo,
      channelRepo,
      this.queueManager,
      router,
      this.auditLogger!,
      this.logger,
    );

    this.rebuildChannelRegistrations(config);

    // ------------------------------------------------------------------
    // 9. Start channel connectors (non-fatal: log and continue)
    // ------------------------------------------------------------------
    await this.startChannelsBestEffort();

    // ------------------------------------------------------------------
    // 10. Start queue processing loop
    // ------------------------------------------------------------------
    this.queueManager.startProcessing((item) => this.handleQueueItem(item));

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
    // 13. Start IPC server
    // ------------------------------------------------------------------
    const ipcBase = join(this.dataDir, 'ipc/daemon');
    this.ipcServer = new DaemonIpcServer({
      inputDir: join(ipcBase, 'input'),
      outputDir: join(ipcBase, 'output'),
      errorsDir: join(ipcBase, 'errors'),
      logger: this.logger,
      commandHandler: (cmd: DaemonCommand) => this.handleIpcCommand(cmd),
    });
    this.ipcServer.start();
    this.logger.info('daemon: IPC server started');

    // ------------------------------------------------------------------
    // 14. Mark running
    // ------------------------------------------------------------------
    this._state = 'running';
    this.startedAt = Date.now();
    this.logger.info('daemon: running');

    // ------------------------------------------------------------------
    // 14. Start watchdog notifier
    //     Interval is set to 10 seconds by default; WatchdogSec in the
    //     systemd unit file should be at least 2× this value (30 s).
    // ------------------------------------------------------------------
    this.watchdog = new WatchdogNotifier({
      intervalMs: 10_000,
      logger: this.logger,
      dataDir: this.dataDir,
    });
    this.watchdog.start();
    this.watchdog.notifyReady();

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

    // 0. Notify watchdog that graceful shutdown is beginning
    if (this.watchdog !== null) {
      this.watchdog.notifyStopping();
      this.watchdog.stop();
      this.watchdog = null;
    }

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

    if (this.mcpRegistry !== null) {
      await this.mcpRegistry.stopAll();
      this.mcpRegistry = null;
      this.mcpProxy = null;
    }

    if (this.sessionTracker !== null) {
      this.sessionTracker.clearAll();
      this.sessionTracker = null;
    }

    if (this.sandboxManager !== null) {
      await this.sandboxManager.shutdownAll();
      this.sandboxManager = null;
      this.sdkProcessSpawner = null;
    }

    // 3. Stop queue processing
    if (this.queueManager !== null) {
      this.queueManager.stopProcessing();
      this.queueManager = null;
    }

    // 3b. Stop IPC server
    if (this.ipcServer !== null) {
      this.ipcServer.stop();
      this.ipcServer = null;
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
    this.configPath = null;
    this.currentConfig = null;
    this.threadWorkspace = null;
    this.queueRepo = null;
    this.threadRepo = null;
    this.channelRepo = null;
    this.personaRepo = null;
    this.runRepo = null;
    this.messageRepo = null;
    this.bindingRepo = null;
    this.auditLogger = null;
    this.messagePipeline = null;
    this.personaLoader = null;
    this.skillLoader = null;
    this.skillResolver = null;
    this.loadedSkills = [];
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
      this.channelRegistry !== null ? this.channelRegistry.listAll().map((c) => c.name) : [];

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
   * Hot-reloads the daemon configuration without restarting subsystems.
   *
   * What is applied immediately:
   * - Log level changes (updates the pino logger level in-place)
   *
   * What is logged but NOT applied (requires restart):
   * - Queue / scheduler config changes
   * - Container image changes (logged as a warning)
   *
   * What is logged for future connector re-registration:
   * - Channel additions / removals
   * - Persona additions / changes / removals
   *
   * Active containers in flight are NOT affected; changes apply to new runs
   * only.
   *
   * @param configPath - Path to reload the config from.
   *                     Defaults to the path used at startup if omitted.
   * @returns Ok(void) on success, Err(DaemonError) if config re-read fails.
   */
  async reload(configPath?: string): Promise<Result<void, DaemonError>> {
    if (this._state !== 'running') {
      return err(
        new DaemonError(`Cannot reload daemon in state '${this._state}' (expected 'running')`),
      );
    }

    // Resolve the effective config path: argument > saved startup path.
    const effectivePath = configPath ?? this.configPath;
    if (effectivePath === null) {
      // This should not happen in normal usage (configPath is always set on start),
      // but guard defensively.
      this.logger.info('daemon: reload requested but no configPath is known — skipping');
      return ok(undefined);
    }

    // Re-read and validate the config file.
    const configResult = loadConfig(effectivePath);
    if (configResult.isErr()) {
      return err(
        new DaemonError(
          `Failed to reload config: ${configResult.error.message}`,
          configResult.error,
        ),
      );
    }

    const newConfig = configResult.value;
    const oldConfig = this.currentConfig;

    this.logger.info({ configPath: effectivePath }, 'daemon: applying hot-reload');

    // ------------------------------------------------------------------
    // Log level — apply immediately to the live logger instance
    // ------------------------------------------------------------------
    if (oldConfig === null || newConfig.logLevel !== oldConfig.logLevel) {
      this.logger.info(
        { from: oldConfig?.logLevel ?? 'unknown', to: newConfig.logLevel },
        'daemon: log level changed — applying immediately',
      );
      this.logger.level = newConfig.logLevel;
    }

    // ------------------------------------------------------------------
    // Channel changes
    // ------------------------------------------------------------------
    if (oldConfig !== null) {
      const oldChannelNames = new Set(oldConfig.channels.map((c) => c.name));
      const newChannelNames = new Set(newConfig.channels.map((c) => c.name));

      const added = newConfig.channels
        .filter((c) => !oldChannelNames.has(c.name))
        .map((c) => c.name);

      const removed = oldConfig.channels
        .filter((c) => !newChannelNames.has(c.name))
        .map((c) => c.name);

      if (added.length > 0) {
        this.logger.info({ added }, 'daemon: reload — new channels detected');
      }
      if (removed.length > 0) {
        this.logger.info({ removed }, 'daemon: reload — channels removed');
      }
    }

    // ------------------------------------------------------------------
    // Persona changes
    // ------------------------------------------------------------------
    if (oldConfig !== null) {
      const oldPersonaNames = new Set(oldConfig.personas.map((p) => p.name));
      const newPersonaNames = new Set(newConfig.personas.map((p) => p.name));

      const addedPersonas = newConfig.personas
        .filter((p) => !oldPersonaNames.has(p.name))
        .map((p) => p.name);

      const removedPersonas = oldConfig.personas
        .filter((p) => !newPersonaNames.has(p.name))
        .map((p) => p.name);

      const changedPersonas = newConfig.personas
        .filter((p) => {
          if (!oldPersonaNames.has(p.name)) return false;
          const old = oldConfig.personas.find((op) => op.name === p.name);
          return JSON.stringify(old) !== JSON.stringify(p);
        })
        .map((p) => p.name);

      if (addedPersonas.length > 0) {
        this.logger.info({ added: addedPersonas }, 'daemon: reload — personas added');
      }
      if (removedPersonas.length > 0) {
        this.logger.info({ removed: removedPersonas }, 'daemon: reload — personas removed');
      }
      if (changedPersonas.length > 0) {
        this.logger.info({ changed: changedPersonas }, 'daemon: reload — personas changed');
      }
    }

    // ------------------------------------------------------------------
    // Queue / scheduler config changes — require restart
    // ------------------------------------------------------------------
    if (oldConfig !== null) {
      const queueChanged = JSON.stringify(oldConfig.queue) !== JSON.stringify(newConfig.queue);
      if (queueChanged) {
        this.logger.warn('daemon: reload — queue config changed; restart required to apply');
      }

      const schedulerChanged =
        JSON.stringify(oldConfig.scheduler) !== JSON.stringify(newConfig.scheduler);
      if (schedulerChanged) {
        this.logger.warn('daemon: reload — scheduler config changed; restart required to apply');
      }
    }

    // ------------------------------------------------------------------
    // Container image changes — warn operator
    // ------------------------------------------------------------------
    if (oldConfig !== null && oldConfig.sandbox.image !== newConfig.sandbox.image) {
      this.logger.warn(
        { from: oldConfig.sandbox.image, to: newConfig.sandbox.image },
        'daemon: reload — container image changed — manual rolling restart required',
      );
    }

    const personaLoader = this.personaLoader;
    const skillLoader = this.skillLoader;
    if (personaLoader === null || skillLoader === null) {
      return err(new DaemonError('daemon subsystems not initialized for reload'));
    }

    const personaReload = await personaLoader.loadFromConfig(newConfig.personas);
    if (personaReload.isErr()) {
      return err(new DaemonError(`Failed to reload personas: ${personaReload.error.message}`));
    }

    const uniqueSkillNames = new Set<string>();
    for (const persona of newConfig.personas) {
      for (const skill of persona.skills) {
        uniqueSkillNames.add(skill);
      }
    }

    const skillDirs: string[] = [];
    for (const skillName of uniqueSkillNames) {
      const candidates = [
        join(process.cwd(), 'skills', skillName),
        join(this.dataDir, 'skills', skillName),
      ];
      let foundPath: string | null = null;
      for (const candidate of candidates) {
        try {
          await access(candidate, fsConstants.R_OK);
          foundPath = candidate;
          break;
        } catch {
          continue;
        }
      }
      if (foundPath !== null) {
        skillDirs.push(foundPath);
      } else {
        this.logger.warn(
          { skillName },
          'daemon: skill directory not found during reload; skipping',
        );
      }
    }

    if (skillDirs.length > 0) {
      const skillsResult = await skillLoader.loadMultiple(skillDirs);
      if (skillsResult.isErr()) {
        return err(new DaemonError(`Failed to reload skills: ${skillsResult.error.message}`));
      }
      this.loadedSkills = skillsResult.value;
    } else {
      this.loadedSkills = [];
    }

    await this.rebuildMcpRegistrations();
    await this.reconfigureChannels(newConfig);

    // Update the cached config snapshot so the next reload has an accurate baseline.
    this.currentConfig = newConfig;

    this.logger.info('daemon: hot-reload complete');
    return ok(undefined);
  }

  private rebuildChannelRegistrations(config: TalondConfig): void {
    const channelRegistry = this.channelRegistry;
    if (channelRegistry === null) {
      return;
    }

    for (const channelConfig of config.channels.filter((channel) => channel.enabled)) {
      const connector = createConnector(
        channelConfig.type,
        channelConfig.name,
        channelConfig.config,
        this.logger,
      );
      if (connector === null) {
        this.logger.warn(
          { channelName: channelConfig.name, channelType: channelConfig.type },
          'daemon: failed to construct channel connector; skipping',
        );
        continue;
      }

      // Ensure the channel exists in the database so the message pipeline
      // can resolve it by name.
      if (this.channelRepo !== null) {
        const existing = this.channelRepo.findByName(channelConfig.name);
        let channelId: string;
        if (existing.isOk() && existing.value !== null) {
          channelId = existing.value.id;
        } else {
          channelId = uuidv4();
          this.channelRepo.insert({
            id: channelId,
            type: channelConfig.type,
            name: channelConfig.name,
            config: JSON.stringify(channelConfig.config),
            credentials_ref: null,
            enabled: 1,
          });
        }

        // Create a default binding to the first persona if none exists.
        if (this.bindingRepo !== null && this.personaRepo !== null && config.personas.length > 0) {
          const defaultBinding = this.bindingRepo.findDefaultForChannel(channelId);
          if (defaultBinding.isOk() && defaultBinding.value === null) {
            const personaResult = this.personaRepo.findByName(config.personas[0].name);
            if (personaResult.isOk() && personaResult.value !== null) {
              this.bindingRepo.insert({
                id: uuidv4(),
                channel_id: channelId,
                thread_id: null,
                persona_id: personaResult.value.id,
                is_default: 1,
              });
              this.logger.info(
                { channelName: channelConfig.name, persona: config.personas[0].name },
                'daemon: created default channel->persona binding',
              );
            }
          }
        }
      }

      connector.onMessage(async (event: InboundEvent) => {
        if (this.messagePipeline === null) {
          return;
        }
        const pipelineResult = await this.messagePipeline.handleInboundEvent(event);
        if (pipelineResult.isErr()) {
          this.logger.error(
            { channelName: event.channelName, err: pipelineResult.error.message },
            'daemon: inbound message pipeline failed',
          );
        }
      });

      channelRegistry.register(connector);
    }
  }

  private async startChannelsBestEffort(): Promise<void> {
    if (this.channelRegistry === null) {
      return;
    }

    try {
      await this.channelRegistry.startAll();
      this.logger.info('daemon: all channel connectors started');
    } catch (cause) {
      this.logger.error(
        { cause },
        'daemon: one or more channel connectors failed to start — continuing without them',
      );
    }
  }

  private async reconfigureChannels(config: TalondConfig): Promise<void> {
    const channelRegistry = this.channelRegistry;
    if (channelRegistry === null) {
      return;
    }

    await channelRegistry.stopAll();
    for (const connector of channelRegistry.listAll()) {
      channelRegistry.unregister(connector.name);
    }

    this.rebuildChannelRegistrations(config);
    await this.startChannelsBestEffort();
  }

  private async rebuildMcpRegistrations(): Promise<void> {
    if (this.mcpRegistry !== null) {
      await this.mcpRegistry.stopAll();
    }

    this.mcpRegistry = new McpRegistry(this.logger);
    for (const skill of this.loadedSkills) {
      for (const server of skill.resolvedMcpServers) {
        try {
          this.mcpRegistry.register(server.name, server.config);
        } catch (cause) {
          this.logger.warn(
            { mcpServer: server.name, cause: String(cause) },
            'daemon: failed to register MCP server definition',
          );
        }
      }
    }
    await this.mcpRegistry.startAll();
    this.mcpProxy = new McpProxy(this.mcpRegistry, this.logger);
  }

  // ---------------------------------------------------------------------------
  // IPC command handler
  // ---------------------------------------------------------------------------

  /**
   * Handles a {@link DaemonCommand} received over IPC and returns a
   * {@link DaemonResponse}.
   *
   * Dispatches on the command type:
   *   - `status`   → calls `health()` and maps health data into the response
   *   - `reload`   → calls `reload()` with optional config path from payload
   *   - `shutdown` → calls `stop()` and returns success
   *   - unknown    → returns an error response
   *
   * @param command - The validated command received from the IPC input dir.
   */
  private async handleIpcCommand(command: DaemonCommand): Promise<DaemonResponse> {
    const { randomUUID } = await import('crypto');
    const responseId = randomUUID();

    switch (command.command) {
      case 'status': {
        const healthData = this.health();
        const runRepo = this.runRepo;
        const tokenUsage24h =
          runRepo === null
            ? undefined
            : runRepo.aggregateByPeriod(Date.now() - 24 * 60 * 60 * 1000).match(
                (aggregate) => ({
                  inputTokens: aggregate.total_input_tokens,
                  outputTokens: aggregate.total_output_tokens,
                  costUsd: aggregate.total_cost_usd,
                }),
                () => undefined,
              );

        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: {
            uptimeMs: healthData.uptime,
            activeContainers: this.sandboxManager?.activeCount() ?? 0,
            queueDepth:
              healthData.queueStats.pending +
              healthData.queueStats.claimed +
              healthData.queueStats.processing,
            personaCount: this.currentConfig?.personas.length ?? 0,
            channelCount:
              this.currentConfig?.channels.filter((channel) => channel.enabled).length ?? 0,
            deadLetterCount: healthData.queueStats.deadLetter,
            ...(tokenUsage24h !== undefined ? { tokenUsage24h } : {}),
          },
        };
      }

      case 'reload': {
        const configPath =
          typeof command.payload?.configPath === 'string' ? command.payload.configPath : undefined;
        const reloadResult = await this.reload(configPath);
        if (reloadResult.isErr()) {
          return {
            id: responseId,
            commandId: command.id,
            success: false,
            error: reloadResult.error.message,
          };
        }
        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: {
            configReloaded: true,
            personasReloaded: true,
            channelsReloaded: true,
          },
        };
      }

      case 'shutdown': {
        // Fire-and-forget the actual stop so the response can be written first.
        setImmediate(() => {
          void this.stop();
        });
        return {
          id: responseId,
          commandId: command.id,
          success: true,
          data: { message: 'Shutdown initiated' },
        };
      }

      default: {
        const unknownCommand = (command as DaemonCommand).command;
        return {
          id: responseId,
          commandId: command.id,
          success: false,
          error: `Unknown command: ${String(unknownCommand)}`,
        };
      }
    }
  }

  private async handleQueueItem(item: QueueItem): Promise<Result<void, Error>> {
    const runRepo = this.runRepo;
    const threadRepo = this.threadRepo;
    const channelRepo = this.channelRepo;
    const personaRepo = this.personaRepo;
    const personaLoader = this.personaLoader;
    const sandboxManager = this.sandboxManager;
    const sdkProcessSpawner = this.sdkProcessSpawner;
    const sessionTracker = this.sessionTracker;
    const channelRegistry = this.channelRegistry;
    const messageRepo = this.messageRepo;
    const threadWorkspace = this.threadWorkspace;
    const currentConfig = this.currentConfig;

    if (
      runRepo === null ||
      threadRepo === null ||
      channelRepo === null ||
      personaRepo === null ||
      personaLoader === null ||
      sandboxManager === null ||
      sdkProcessSpawner === null ||
      sessionTracker === null ||
      channelRegistry === null ||
      messageRepo === null ||
      threadWorkspace === null ||
      currentConfig === null
    ) {
      return err(new Error('daemon dispatch dependencies are not initialized'));
    }

    const personaId = typeof item.payload.personaId === 'string' ? item.payload.personaId : null;
    if (personaId === null) {
      return err(new Error(`queue item ${item.id} is missing payload.personaId`));
    }

    const personaRowResult = personaRepo.findById(personaId);
    if (personaRowResult.isErr() || personaRowResult.value === null) {
      return err(new Error(`persona not found for id ${personaId}`));
    }

    const personaName = personaRowResult.value.name;
    const loadedPersonaResult = personaLoader.getByName(personaName);
    if (loadedPersonaResult.isErr() || loadedPersonaResult.value === undefined) {
      return err(new Error(`loaded persona not found for ${personaName}`));
    }
    const loadedPersona = loadedPersonaResult.value;

    const runId = uuidv4();
    const now = Date.now();
    const runInsert = runRepo.insert({
      id: runId,
      thread_id: item.threadId,
      persona_id: personaId,
      sandbox_id: null,
      session_id: sessionTracker.getSessionId(item.threadId) ?? null,
      status: 'running',
      parent_run_id: null,
      queue_item_id: item.id,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: now,
      ended_at: null,
    });

    if (runInsert.isErr()) {
      return err(new Error(`failed to create run record: ${runInsert.error.message}`));
    }

    const workspaceResult = threadWorkspace.ensureDirectories(item.threadId);
    if (workspaceResult.isErr()) {
      runRepo.updateStatus(runId, 'failed', {
        ended_at: Date.now(),
        error: workspaceResult.error.message,
      });
      return err(new Error(workspaceResult.error.message));
    }

    try {
      const content = typeof item.payload.content === 'string' ? item.payload.content : '';
      const skillPrompt =
        this.skillResolver === null
          ? ''
          : this.skillResolver.mergePromptFragments(
              this.loadedSkills.filter((skill) =>
                loadedPersona.config.skills.includes(skill.manifest.name),
              ),
            );

      const model = loadedPersona.config.model;
      const authMode = currentConfig.auth.mode;
      const apiKey = authMode === 'api_key' ? process.env.ANTHROPIC_API_KEY : undefined;
      if (authMode === 'api_key' && (!apiKey || apiKey.trim() === '')) {
        throw new Error('auth.mode is api_key but ANTHROPIC_API_KEY is not set');
      }

      const systemPrompt = [loadedPersona.systemPromptContent ?? '', skillPrompt]
        .filter(Boolean)
        .join('\n\n');

      // ----------------------------------------------------------------
      // DIRECT MODE: Call Claude API from host process (temporary).
      // Bypasses container sandboxing. See TODO.md TASK-035 for the
      // proper in-container agent runner that replaces this.
      // ----------------------------------------------------------------
      this.logger.info(
        { runId, personaId, model, threadId: item.threadId },
        'direct mode: calling Claude API from host',
      );

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic(apiKey ? { apiKey } : {});

      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      });

      const outputText = response.content
        .filter((block) => block.type === 'text')
        .map((block) => 'text' in block ? (block as { text: string }).text : '')
        .join('\n');

      this.logger.info(
        {
          runId,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        'direct mode: Claude API response received',
      );

      const threadResult = threadRepo.findById(item.threadId);
      if (threadResult.isErr() || threadResult.value === null) {
        throw new Error(`thread not found for id ${item.threadId}`);
      }

      const channelResult = channelRepo.findById(threadResult.value.channel_id);
      if (channelResult.isErr() || channelResult.value === null) {
        throw new Error(`channel not found for id ${threadResult.value.channel_id}`);
      }

      const connector = channelRegistry.get(channelResult.value.name);
      if (connector !== undefined) {
        const sendResult = await connector.send(threadResult.value.external_id, {
          body: outputText,
        });
        if (sendResult.isErr()) {
          throw new Error(`channel send failed: ${sendResult.error.message}`);
        }
      }

      messageRepo.insert({
        id: uuidv4(),
        thread_id: item.threadId,
        direction: 'outbound',
        content: JSON.stringify({ body: outputText }),
        idempotency_key: `outbound:${runId}`,
        provider_id: null,
        run_id: runId,
      });

      runRepo.updateStatus(runId, 'completed', {
        ended_at: Date.now(),
      });
      return ok(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      runRepo.updateStatus(runId, 'failed', { ended_at: Date.now(), error: message });
      return err(new Error(message));
    }
  }
}

class RepositoryAuditStore implements AuditStore {
  constructor(private readonly auditRepo: AuditRepository) {}

  append(entry: AuditEntry): void {
    this.auditRepo.insert({
      id: uuidv4(),
      run_id: entry.runId ?? null,
      thread_id: entry.threadId ?? null,
      persona_id: entry.personaId ?? null,
      action: entry.action,
      tool: entry.tool ?? null,
      request_id: entry.requestId ?? null,
      details: JSON.stringify(entry.details),
    });
  }
}

function createConnector(
  type: string,
  name: string,
  config: Record<string, unknown>,
  logger: pino.Logger,
): ChannelConnector | null {
  switch (type) {
    case 'telegram':
      return new TelegramConnector(config as unknown as TelegramConfig, name, logger);
    case 'slack':
      return new SlackConnector(config as unknown as SlackConfig, name, logger);
    case 'discord':
      return new DiscordConnector(config as unknown as DiscordConfig, name, logger);
    case 'whatsapp':
      return new WhatsAppConnector(config as unknown as WhatsAppConfig, name, logger);
    case 'email':
      return new EmailConnector(config as unknown as EmailConfig, name, logger);
    default:
      return null;
  }
}
