# Task TASK-027: Multi-agent collaboration — supervisor/worker, child runs

## Changes Made

- `src/core/errors/error-types.ts` — Added `CollaborationError` class extending `TalonError` with code `'COLLABORATION_ERROR'`
- `src/core/errors/index.ts` — Re-exported `CollaborationError`
- `src/collaboration/collaboration-types.ts` — New file with type definitions: `RetryPolicy`, `SupervisorConfig`, `WorkerConfig`, `ChildRunInfo`, `CollaborationSession`, `WorkerResult`
- `src/collaboration/supervisor.ts` — New `Supervisor` class managing in-memory sessions, child run creation via RunRepository, worker completion, and session finalisation
- `src/collaboration/worker-manager.ts` — New `WorkerManager` class tracking child runs with two indexes (by-parent and by-id), status updates, channel-message policy guard, and aggregate stats
- `src/collaboration/index.ts` — Updated barrel to export all new types and classes
- `tests/unit/core/errors/error-types.test.ts` — Added `CollaborationError` to the existing parametric test suite (9 new tests)

## Tests Added

- `tests/unit/collaboration/supervisor.test.ts` — 26 tests covering:
  - `createSession`: happy path, unique IDs, empty-runId error, getSession retrieval
  - `spawnWorker`: happy path, repo insert called, workers list updated, session-not-found error, max-workers error, persona-not-allowed error, repo insert failure, spawning on completed session
  - `completeWorker`: success and failure outcomes, updateStatus call, session-not-found, worker-not-found, repo update failure
  - `completeSession`: all-succeeded, any-failed, no-workers, session-not-found, active-workers error, final state returned
  - `getSession`: unknown session, known session

- `tests/unit/collaboration/worker-manager.test.ts` — 24 tests covering:
  - `trackChildRun`: status, timestamp, multiple children, independent parents
  - `getChildRuns`: unknown parent empty result, all children returned
  - `updateChildStatus`: in-memory status, endedAt on terminal statuses, non-terminal no-endedAt, result string, repo call, unknown-id error, repo failure
  - `canSendChannelMessage`: allowed, not allowed, empty list, unknown run, case sensitivity
  - `getRunSummary`: unknown parent zeros, pending counts as running, running status, mixed statuses

Total new tests: 59 (50 collaboration + 9 error types)

## Deviations from Plan

- `spawnWorker` has an overloaded signature that accepts an optional `supervisorConfig` parameter. This keeps the API flexible: callers with access to the config get persona-name validation and max-workers enforcement, while callers without it (e.g., lower-level integration) can still create child runs without those guards.
- `thread_id` in the inserted run record is set to `supervisorRunId` as a placeholder. The task description notes that actual thread/persona ID resolution from the registry happens in the daemon integration layer (a later task).

## Status

completed

## Notes

- The Supervisor is intentionally stateless across daemon restarts (in-memory Map only). Child run records are durable via the `runs` table.
- The `canSendChannelMessage` guard is a policy check only — it does not intercept actual SDK calls. The enforcement point is expected in the daemon's tool dispatcher.
