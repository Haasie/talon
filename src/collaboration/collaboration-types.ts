/**
 * Type definitions for the multi-agent collaboration system.
 *
 * A collaboration session is orchestrated by a supervisor persona that spawns
 * one or more worker personas to handle parallel subtasks. The supervisor
 * aggregates results when all workers have finished.
 */

import type { RunStatus } from '../core/database/repositories/run-repository.js';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Retry policy applied when a worker run fails. */
export interface RetryPolicy {
  /** Maximum number of retry attempts before treating the worker as failed. */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff between retries. */
  backoffBaseMs: number;
}

/** Configuration for a collaboration session managed by a supervisor persona. */
export interface SupervisorConfig {
  /** Name of the persona acting as the session supervisor. */
  supervisorPersonaName: string;
  /** Names of the worker personas that may be spawned in this session. */
  workerPersonaNames: string[];
  /** Upper bound on the number of concurrently active workers. */
  maxWorkers: number;
  /** Retry policy applied to failed worker runs. */
  retryPolicy: RetryPolicy;
}

/** Configuration for a single worker task within a collaboration session. */
export interface WorkerConfig {
  /** Name of the persona to run as the worker. */
  personaName: string;
  /** Human-readable description of the subtask assigned to this worker. */
  taskDescription: string;
  /** Arbitrary payload passed to the worker at startup. */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime state types
// ---------------------------------------------------------------------------

/**
 * Tracks the lifecycle of a single child run spawned by a supervisor.
 *
 * The child run record is persisted to the `runs` table via RunRepository;
 * this interface mirrors the relevant fields in an application-friendly shape.
 */
export interface ChildRunInfo {
  /** Unique ID of this child run (matches the `runs` table primary key). */
  id: string;
  /** ID of the parent (supervisor) run. */
  parentRunId: string;
  /** Name of the persona assigned to this worker. */
  workerPersonaName: string;
  /** Current lifecycle status of the run. */
  status: RunStatus;
  /** Unix epoch ms when this run was created. */
  startedAt: number;
  /** Unix epoch ms when this run reached a terminal state, or null if still active. */
  endedAt: number | null;
  /** Output produced by the worker, if the run completed successfully. */
  result: string | null;
  /** Error message, if the run failed. */
  error: string | null;
}

/** A collaboration session grouping one supervisor run with its workers. */
export interface CollaborationSession {
  /** Unique ID of this session. */
  id: string;
  /** ID of the supervisor run that owns this session. */
  supervisorRunId: string;
  /** All worker runs spawned within this session. */
  workers: ChildRunInfo[];
  /** Aggregate session status. */
  status: 'active' | 'completed' | 'failed';
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome reported for a single worker run after it reaches a terminal state. */
export interface WorkerResult {
  /** ID of the worker (child run). */
  workerId: string;
  /** Whether the worker run completed successfully. */
  success: boolean;
  /** Worker output, if successful. */
  output: string | null;
  /** Error message, if the worker failed. */
  error: string | null;
}
