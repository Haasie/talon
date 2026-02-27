/**
 * Supervisor — coordination layer for multi-agent collaboration sessions.
 *
 * Manages the lifecycle of a collaboration session: creating sessions,
 * spawning worker records in the run repository, completing individual
 * workers, and finalising the session once all workers have settled.
 *
 * This module is a data-model and coordination layer only. It does NOT
 * actually start sandboxes or run SDK queries — that responsibility belongs
 * to the daemon's queue processor.
 */

import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { CollaborationError } from '../core/errors/index.js';
import type { RunRepository } from '../core/database/repositories/run-repository.js';
import type {
  SupervisorConfig,
  WorkerConfig,
  ChildRunInfo,
  CollaborationSession,
  WorkerResult,
} from './collaboration-types.js';

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/**
 * Coordinates a collaboration session between a supervisor and worker personas.
 *
 * Sessions are stored in an in-memory Map; child run records are persisted to
 * the `runs` table via RunRepository so they survive across in-process
 * queries even though session metadata does not survive daemon restarts.
 */
export class Supervisor {
  /** In-memory store of active and recently completed sessions. */
  private readonly sessions = new Map<string, CollaborationSession>();

  constructor(
    private readonly runRepo: RunRepository,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Creates a new collaboration session owned by the given supervisor run.
   *
   * Returns an error if the supervisorRunId is empty.
   */
  createSession(
    supervisorRunId: string,
    config: SupervisorConfig,
  ): Result<CollaborationSession, CollaborationError> {
    if (!supervisorRunId) {
      return err(new CollaborationError('supervisorRunId must not be empty'));
    }

    const session: CollaborationSession = {
      id: uuidv4(),
      supervisorRunId,
      workers: [],
      status: 'active',
    };

    this.sessions.set(session.id, session);

    this.logger.debug(
      { sessionId: session.id, supervisorRunId, config },
      'collaboration session created',
    );

    return ok(session);
  }

  /**
   * Spawns a worker by creating a child run record in the run repository.
   *
   * The run is inserted with `parent_run_id` pointing to the supervisor run
   * and with status `'pending'`. Actual sandbox execution is handled elsewhere.
   *
   * Returns an error if:
   * - The session is not found.
   * - The session is no longer active.
   * - The worker persona is not in the allowed list for this session's config.
   * - The worker limit has been reached (active workers >= maxWorkers).
   * - The run repository insert fails.
   */
  spawnWorker(
    sessionId: string,
    workerConfig: WorkerConfig,
    supervisorConfig: SupervisorConfig,
  ): Result<ChildRunInfo, CollaborationError>;

  spawnWorker(
    sessionId: string,
    workerConfig: WorkerConfig,
  ): Result<ChildRunInfo, CollaborationError>;

  spawnWorker(
    sessionId: string,
    workerConfig: WorkerConfig,
    supervisorConfig?: SupervisorConfig,
  ): Result<ChildRunInfo, CollaborationError> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(new CollaborationError(`Session not found: ${sessionId}`));
    }

    if (session.status !== 'active') {
      return err(
        new CollaborationError(
          `Cannot spawn worker on a ${session.status} session: ${sessionId}`,
        ),
      );
    }

    // Enforce max-workers limit when a config is provided.
    if (supervisorConfig !== undefined) {
      const activeWorkers = session.workers.filter(
        (w) => w.status === 'pending' || w.status === 'running',
      );
      if (activeWorkers.length >= supervisorConfig.maxWorkers) {
        return err(
          new CollaborationError(
            `Worker limit reached (${supervisorConfig.maxWorkers}) for session: ${sessionId}`,
          ),
        );
      }

      // Validate that the persona is allowed for this session.
      if (!supervisorConfig.workerPersonaNames.includes(workerConfig.personaName)) {
        return err(
          new CollaborationError(
            `Persona '${workerConfig.personaName}' is not in the allowed worker list for session: ${sessionId}`,
          ),
        );
      }
    }

    const workerId = uuidv4();
    const now = Date.now();

    // Persist the child run record. We use a placeholder thread_id and
    // persona_id here — the daemon integration layer is expected to resolve
    // actual IDs from the persona registry before calling spawnWorker.
    const insertResult = this.runRepo.insert({
      id: workerId,
      thread_id: session.supervisorRunId, // placeholder — replaced during integration
      persona_id: workerConfig.personaName, // persona name used as placeholder id
      sandbox_id: null,
      session_id: sessionId,
      status: 'pending',
      parent_run_id: session.supervisorRunId,
      queue_item_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: now,
      ended_at: null,
    });

    if (insertResult.isErr()) {
      return err(
        new CollaborationError(
          `Failed to create child run record: ${insertResult.error.message}`,
          insertResult.error,
        ),
      );
    }

    const childRun: ChildRunInfo = {
      id: workerId,
      parentRunId: session.supervisorRunId,
      workerPersonaName: workerConfig.personaName,
      status: 'pending',
      startedAt: now,
      endedAt: null,
      result: null,
      error: null,
    };

    session.workers.push(childRun);

    this.logger.debug(
      { sessionId, workerId, personaName: workerConfig.personaName },
      'worker spawned',
    );

    return ok(childRun);
  }

  /**
   * Records the outcome of a worker run and updates its run record.
   *
   * Returns an error if the session or worker is not found.
   */
  completeWorker(
    sessionId: string,
    workerId: string,
    result: WorkerResult,
  ): Result<void, CollaborationError> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(new CollaborationError(`Session not found: ${sessionId}`));
    }

    const worker = session.workers.find((w) => w.id === workerId);
    if (!worker) {
      return err(
        new CollaborationError(`Worker not found: ${workerId} in session: ${sessionId}`),
      );
    }

    const now = Date.now();
    const terminalStatus = result.success ? 'completed' : 'failed';

    // Update the persisted run record.
    const updateResult = this.runRepo.updateStatus(workerId, terminalStatus, {
      ended_at: now,
      error: result.error ?? undefined,
    });

    if (updateResult.isErr()) {
      return err(
        new CollaborationError(
          `Failed to update worker run status: ${updateResult.error.message}`,
          updateResult.error,
        ),
      );
    }

    // Update the in-memory worker entry.
    worker.status = terminalStatus;
    worker.endedAt = now;
    worker.result = result.output;
    worker.error = result.error;

    this.logger.debug(
      { sessionId, workerId, success: result.success },
      'worker completed',
    );

    return ok(undefined);
  }

  /**
   * Returns the session with the given ID, or undefined if not found.
   */
  getSession(sessionId: string): CollaborationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Finalises the session by computing its aggregate status from worker outcomes.
   *
   * A session is marked `'completed'` when all workers have reached a terminal
   * state and at least one succeeded (none failed). If any worker failed, the
   * session is marked `'failed'`. If workers are still active, the session
   * remains `'active'` and an error is returned.
   *
   * Returns an error if the session is not found or workers are still running.
   */
  completeSession(sessionId: string): Result<CollaborationSession, CollaborationError> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(new CollaborationError(`Session not found: ${sessionId}`));
    }

    const activeWorkers = session.workers.filter(
      (w) => w.status === 'pending' || w.status === 'running',
    );

    if (activeWorkers.length > 0) {
      return err(
        new CollaborationError(
          `Cannot complete session with ${activeWorkers.length} active worker(s): ${sessionId}`,
        ),
      );
    }

    const hasFailures = session.workers.some((w) => w.status === 'failed');
    session.status = hasFailures ? 'failed' : 'completed';

    this.logger.debug(
      { sessionId, status: session.status, workerCount: session.workers.length },
      'collaboration session completed',
    );

    return ok(session);
  }
}
