/**
 * WorkerManager — tracks child runs spawned within collaboration sessions.
 *
 * Provides an in-memory index of child runs keyed by parent run ID, backed by
 * a RunRepository for persistence. Also enforces the channel-message policy
 * for worker personas: workers may only send channel messages if their persona
 * name is explicitly listed in the allowed set.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { CollaborationError } from '../core/errors/index.js';
import type { RunRepository, RunStatus } from '../core/database/repositories/run-repository.js';
import type { ChildRunInfo } from './collaboration-types.js';

// ---------------------------------------------------------------------------
// WorkerManager
// ---------------------------------------------------------------------------

/**
 * Manages child run tracking and worker policy enforcement.
 *
 * Child runs are indexed in memory (parentRunId -> ChildRunInfo[]) and their
 * status is kept in sync with the `runs` table via RunRepository updates.
 */
export class WorkerManager {
  /**
   * In-memory index: parent run ID -> list of child run infos.
   * Populated via trackChildRun and updated via updateChildStatus.
   */
  private readonly childRunsByParent = new Map<string, ChildRunInfo[]>();

  /**
   * Secondary index: child run ID -> ChildRunInfo for O(1) lookups.
   */
  private readonly childRunsById = new Map<string, ChildRunInfo>();

  constructor(
    private readonly runRepo: RunRepository,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Registers a child run for tracking under the given parent run.
   *
   * Creates a ChildRunInfo entry with status `'pending'` and adds it to both
   * the parent index and the id index.
   */
  trackChildRun(
    parentRunId: string,
    childRunId: string,
    personaName: string,
  ): ChildRunInfo {
    const childRun: ChildRunInfo = {
      id: childRunId,
      parentRunId,
      workerPersonaName: personaName,
      status: 'pending',
      startedAt: Date.now(),
      endedAt: null,
      result: null,
      error: null,
    };

    const siblings = this.childRunsByParent.get(parentRunId) ?? [];
    siblings.push(childRun);
    this.childRunsByParent.set(parentRunId, siblings);
    this.childRunsById.set(childRunId, childRun);

    this.logger.debug(
      { parentRunId, childRunId, personaName },
      'child run tracked',
    );

    return childRun;
  }

  /**
   * Returns all child runs recorded for the given parent run.
   *
   * Returns an empty array if the parent run has no tracked children.
   */
  getChildRuns(parentRunId: string): ChildRunInfo[] {
    return this.childRunsByParent.get(parentRunId) ?? [];
  }

  /**
   * Updates the status of a tracked child run and persists the change.
   *
   * Returns an error if the child run ID is not in the in-memory index or
   * if the RunRepository update fails.
   */
  updateChildStatus(
    childRunId: string,
    status: RunStatus,
    result?: string,
    error?: string,
  ): Result<void, CollaborationError> {
    const childRun = this.childRunsById.get(childRunId);
    if (!childRun) {
      return err(
        new CollaborationError(`Child run not found in tracker: ${childRunId}`),
      );
    }

    const now = Date.now();
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';

    const updateResult = this.runRepo.updateStatus(childRunId, status, {
      ended_at: isTerminal ? now : undefined,
      error: error ?? undefined,
    });

    if (updateResult.isErr()) {
      return err(
        new CollaborationError(
          `Failed to update child run status: ${updateResult.error.message}`,
          updateResult.error,
        ),
      );
    }

    // Keep in-memory state consistent.
    childRun.status = status;
    if (isTerminal) {
      childRun.endedAt = now;
    }
    if (result !== undefined) {
      childRun.result = result;
    }
    if (error !== undefined) {
      childRun.error = error;
    }

    this.logger.debug({ childRunId, status }, 'child run status updated');

    return ok(undefined);
  }

  /**
   * Returns true only if the child run's persona name is in the allowed list.
   *
   * Workers should generally not send channel messages — only the supervisor
   * persona should. This guard enforces that policy. Pass the supervisor's
   * allowed-persona list; the worker will be permitted only if its persona name
   * is explicitly included.
   *
   * Returns false if the child run is not tracked.
   */
  canSendChannelMessage(childRunId: string, allowedPersonas: string[]): boolean {
    const childRun = this.childRunsById.get(childRunId);
    if (!childRun) {
      return false;
    }
    return allowedPersonas.includes(childRun.workerPersonaName);
  }

  /**
   * Returns aggregate run statistics for all children of the given parent run.
   */
  getRunSummary(parentRunId: string): {
    total: number;
    completed: number;
    failed: number;
    running: number;
  } {
    const children = this.childRunsByParent.get(parentRunId) ?? [];
    return {
      total: children.length,
      completed: children.filter((c) => c.status === 'completed').length,
      failed: children.filter((c) => c.status === 'failed').length,
      running: children.filter((c) => c.status === 'running' || c.status === 'pending').length,
    };
  }
}
