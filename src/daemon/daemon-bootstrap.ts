/**
 * DaemonBootstrap — builds a fully-initialized DaemonContext.
 *
 * Handles the pure setup phase: config loading, database, migrations,
 * repositories, persona/skill loading, and subsystem wiring.
 *
 * Does NOT start any services (channels, queue, scheduler, IPC).
 * The daemon orchestrator calls start methods after receiving the context.
 */

import { join } from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';

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
  BindingRepository,
  MemoryRepository,
} from '../core/database/repositories/index.js';

import { ChannelRegistry } from '../channels/channel-registry.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { registerChannels } from '../channels/channel-setup.js';
import { MessagePipeline } from '../pipeline/message-pipeline.js';
import { QueueManager } from '../queue/queue-manager.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { DaemonError } from '../core/errors/error-types.js';
import { AuditLogger } from '../core/logging/audit-logger.js';
import { RepositoryAuditStore } from '../core/database/repositories/audit-repository.js';
import { PersonaLoader } from '../personas/persona-loader.js';
import { SkillLoader } from '../skills/skill-loader.js';
import { SkillResolver } from '../skills/skill-resolver.js';
import { ThreadWorkspace } from '../memory/thread-workspace.js';
import { SessionTracker } from '../sandbox/session-tracker.js';

import { HostToolsBridge } from '../tools/host-tools-bridge.js';
import { SubAgentLoader } from '../subagents/subagent-loader.js';
import { SubAgentRunner } from '../subagents/subagent-runner.js';
import { ModelResolver } from '../subagents/model-resolver.js';
import { recoverFromCrash } from './lifecycle.js';
import type { DaemonContext } from './daemon-context.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Builds a fully-initialized DaemonContext from a config file path.
 *
 * On success, all subsystems are constructed and wired but NOT started.
 * On failure, any partially-opened resources (DB) are cleaned up.
 *
 * @param configPath - Path to the talond.yaml config file.
 * @param logger     - Root pino logger instance.
 * @returns Ok(DaemonContext) or Err(DaemonError).
 */
export async function bootstrap(
  configPath: string,
  logger: pino.Logger,
): Promise<Result<DaemonContext, DaemonError>> {
  logger.info({ configPath }, 'bootstrap: loading config');

  // 1. Load config
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    return err(
      new DaemonError(`Failed to load config: ${configResult.error.message}`, configResult.error),
    );
  }
  const config = configResult.value;
  const dataDir = config.dataDir;
  logger.info({ logLevel: config.logLevel }, 'bootstrap: config loaded');

  // 2. Open database
  const dbResult = createDatabase(config.storage.path);
  if (dbResult.isErr()) {
    return err(
      new DaemonError(`Failed to open database: ${dbResult.error.message}`, dbResult.error),
    );
  }
  const db = dbResult.value;

  // 3. Run migrations
  const migrationsDir = join(import.meta.dirname, '../core/database/migrations');
  const migrationsResult = runMigrations(db, migrationsDir);
  if (migrationsResult.isErr()) {
    db.close();
    return err(
      new DaemonError(
        `Failed to run migrations: ${migrationsResult.error.message}`,
        migrationsResult.error,
      ),
    );
  }
  logger.info({ applied: migrationsResult.value }, 'bootstrap: migrations complete');

  // 4. Create repositories
  const repos = {
    queue: new QueueRepository(db),
    thread: new ThreadRepository(db),
    channel: new ChannelRepository(db),
    persona: new PersonaRepository(db),
    schedule: new ScheduleRepository(db),
    audit: new AuditRepository(db),
    message: new MessageRepository(db),
    run: new RunRepository(db),
    binding: new BindingRepository(db),
    memory: new MemoryRepository(db),
  };

  // 5. Audit logger
  const auditStore = new RepositoryAuditStore(repos.audit);
  const auditLogger = new AuditLogger(logger, auditStore);

  // 6. Thread workspace
  const threadWorkspace = new ThreadWorkspace(dataDir);

  // 7. Load personas
  const personaLoader = new PersonaLoader(repos.persona, logger);
  const personaLoadResult = await personaLoader.loadFromConfig(config.personas);
  if (personaLoadResult.isErr()) {
    db.close();
    return err(
      new DaemonError(
        `Failed to load personas: ${personaLoadResult.error.message}`,
        personaLoadResult.error,
      ),
    );
  }

  // 8. Load skills
  const skillLoader = new SkillLoader(logger);
  const skillResolver = new SkillResolver(logger);
  const loadedSkills = await skillLoader.loadFromPersonaConfig(config.personas, dataDir);
  if (loadedSkills.isErr()) {
    db.close();
    return err(
      new DaemonError(
        `Failed to load skills: ${loadedSkills.error.message}`,
        loadedSkills.error,
      ),
    );
  }

  // 8b. Load sub-agents (optional — if the directory does not exist, skip)
  const subAgentLoader = new SubAgentLoader(logger);
  const subAgentsDir = join(dataDir, 'subagents');
  const loadedSubAgentsResult = await subAgentLoader.loadAll(subAgentsDir);
  let subAgentRunner: SubAgentRunner | null = null;

  if (loadedSubAgentsResult.isOk() && loadedSubAgentsResult.value.length > 0) {
    const agentMap = new Map(loadedSubAgentsResult.value.map((a) => [a.manifest.name, a]));
    const modelResolver = new ModelResolver(config.auth.providers ?? {});
    subAgentRunner = new SubAgentRunner(
      agentMap,
      modelResolver,
      {
        memory: repos.memory,
        schedules: repos.schedule,
        personas: repos.persona,
        channels: repos.channel,
        threads: repos.thread,
        messages: repos.message,
        runs: repos.run,
        queue: repos.queue,
        logger,
      },
      logger,
    );
    logger.info({ subagents: [...agentMap.keys()] }, 'bootstrap: loaded sub-agents');
  } else if (loadedSubAgentsResult.isErr()) {
    logger.warn(
      { error: loadedSubAgentsResult.error.message },
      'bootstrap: failed to load sub-agents, continuing without them',
    );
  }

  // 9. Session tracker
  const sessionTracker = new SessionTracker();

  // 10. Crash recovery
  recoverFromCrash(repos.queue, logger);

  // 11. Channel registry
  const channelRegistry = new ChannelRegistry(logger);

  // 12. Queue manager
  const queueManager = new QueueManager(repos.queue, repos.thread, config.queue, logger);

  // 13. Scheduler
  const scheduler = new Scheduler(repos.schedule, queueManager, config.scheduler, logger);

  // 14. Message pipeline and channel registration
  const router = new ChannelRouter(repos.binding, logger);
  const messagePipeline = new MessagePipeline(
    repos.message,
    repos.thread,
    repos.channel,
    queueManager,
    router,
    auditLogger,
    logger,
  );

  registerChannels(config, channelRegistry, {
    channelRepo: repos.channel,
    bindingRepo: repos.binding,
    personaRepo: repos.persona,
    messagePipeline,
    logger,
  });

  // 15. Host tools bridge (needs a partial context to construct)
  // We build the context object first, then create the bridge and attach it.
  // Two-phase init: HostToolsBridge needs ctx, but ctx needs hostToolsBridge.
  // Build a partial context first, then fill in the bridge field.
  const partialCtx = {
    db,
    config,
    configPath,
    dataDir,
    repos,
    channelRegistry,
    queueManager,
    scheduler,
    personaLoader,
    sessionTracker,
    threadWorkspace,
    auditLogger,
    skillResolver,
    loadedSkills: loadedSkills.value,
    messagePipeline,
    subAgentRunner,
    logger,
  } as Omit<DaemonContext, 'hostToolsBridge'> & { hostToolsBridge?: HostToolsBridge };

  const hostToolsBridge = new HostToolsBridge(partialCtx as DaemonContext);
  partialCtx.hostToolsBridge = hostToolsBridge;
  const ctx = partialCtx as DaemonContext;

  logger.info('bootstrap: context ready');

  return ok(ctx);
}
