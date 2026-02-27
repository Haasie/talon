/**
 * Type definitions for the talond daemon lifecycle.
 *
 * Defines the daemon state machine, health snapshot shape, and the
 * dependency injection interface used in tests to mock subsystems.
 */

import type pino from 'pino';
import type Database from 'better-sqlite3';
import type { TalondConfig } from '../core/config/config-types.js';
import type { QueueStats } from '../queue/queue-manager.js';
import type { ChannelRegistry } from '../channels/channel-registry.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type {
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

// ---------------------------------------------------------------------------
// Daemon state machine
// ---------------------------------------------------------------------------

/**
 * Daemon lifecycle states.
 *
 * Transitions:
 *   stopped → starting → running
 *   running → stopping → stopped
 *   starting | running → error
 */
export type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

// ---------------------------------------------------------------------------
// Health snapshot
// ---------------------------------------------------------------------------

/**
 * Point-in-time health report for the daemon.
 *
 * Returned by `daemon.health()` and exposed over IPC for monitoring.
 */
export interface DaemonHealth {
  /** Current daemon lifecycle state. */
  state: DaemonState;
  /** Uptime in milliseconds since the daemon entered 'running' state. */
  uptime: number;
  /** Queue item counts by status. */
  queueStats: QueueStats;
  /** Names of all registered channel connectors. */
  activeChannels: string[];
  /** Whether the scheduler tick loop is running. */
  schedulerRunning: boolean;
}

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * All subsystem instances that TalondDaemon depends on.
 *
 * Defining them as an interface enables full unit-test mocking without
 * touching the file system or spawning real SQLite connections.
 */
export interface DaemonDependencies {
  /** Validated, frozen daemon configuration. */
  config: TalondConfig;
  /** Open SQLite database connection. */
  db: Database.Database;
  /** Queue item repository. */
  queueRepo: QueueRepository;
  /** Thread repository. */
  threadRepo: ThreadRepository;
  /** Channel row repository. */
  channelRepo: ChannelRepository;
  /** Persona repository. */
  personaRepo: PersonaRepository;
  /** Schedule repository. */
  scheduleRepo: ScheduleRepository;
  /** Audit log repository. */
  auditRepo: AuditRepository;
  /** Message repository. */
  messageRepo: MessageRepository;
  /** Run history repository. */
  runRepo: RunRepository;
  /** Memory item repository. */
  memoryRepo: MemoryRepository;
  /** Artifact repository. */
  artifactRepo: ArtifactRepository;
  /** Channel–persona binding repository. */
  bindingRepo: BindingRepository;
  /** Tool result repository. */
  toolResultRepo: ToolResultRepository;
  /** Channel connector registry. */
  channelRegistry: ChannelRegistry;
  /** Queue manager (background processing loop). */
  queueManager: QueueManager;
  /** Tick-based task scheduler. */
  scheduler: Scheduler;
  /** Root logger instance. */
  logger: pino.Logger;
}
