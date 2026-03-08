/**
 * DaemonContext — fully-initialized runtime state for the daemon.
 *
 * Built once by DaemonBootstrap.bootstrap(). All fields are non-null
 * and readonly, eliminating the defensive null checks that plagued
 * the monolithic TalondDaemon class.
 *
 * Passed by reference to AgentRunner and other subsystems that need
 * access to shared daemon state.
 */

import type pino from 'pino';
import type Database from 'better-sqlite3';
import type { TalondConfig } from '../core/config/config-types.js';
import type {
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
import type { ChannelRegistry } from '../channels/channel-registry.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { PersonaLoader } from '../personas/persona-loader.js';
import type { SessionTracker } from '../sandbox/session-tracker.js';
import type { ThreadWorkspace } from '../memory/thread-workspace.js';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { SkillResolver } from '../skills/skill-resolver.js';
import type { MessagePipeline } from '../pipeline/message-pipeline.js';
import type { HostToolsBridge } from '../tools/host-tools-bridge.js';

// ---------------------------------------------------------------------------
// Repository bundle
// ---------------------------------------------------------------------------

/** All database repositories, grouped for clean dependency passing. */
export interface DaemonRepos {
  readonly queue: QueueRepository;
  readonly thread: ThreadRepository;
  readonly channel: ChannelRepository;
  readonly persona: PersonaRepository;
  readonly schedule: ScheduleRepository;
  readonly audit: AuditRepository;
  readonly message: MessageRepository;
  readonly run: RunRepository;
  readonly binding: BindingRepository;
  readonly memory: MemoryRepository;
}

// ---------------------------------------------------------------------------
// DaemonContext
// ---------------------------------------------------------------------------

/**
 * Immutable runtime context populated during bootstrap.
 *
 * Every field is guaranteed non-null. If bootstrap fails, no context
 * is created — the daemon never enters 'running' state.
 */
export interface DaemonContext {
  readonly db: Database.Database;
  readonly config: TalondConfig;
  readonly configPath: string;
  readonly dataDir: string;
  readonly repos: DaemonRepos;
  readonly channelRegistry: ChannelRegistry;
  readonly queueManager: QueueManager;
  readonly scheduler: Scheduler;
  readonly personaLoader: PersonaLoader;
  readonly sessionTracker: SessionTracker;
  readonly threadWorkspace: ThreadWorkspace;
  readonly auditLogger: AuditLogger;
  readonly skillResolver: SkillResolver;
  readonly loadedSkills: LoadedSkill[];
  readonly messagePipeline: MessagePipeline;
  readonly hostToolsBridge: HostToolsBridge;
  readonly logger: pino.Logger;
}
