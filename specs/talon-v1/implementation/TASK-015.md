# Task TASK-015: Message normalization and deduplication pipeline

## Changes Made

### New source files
- `src/pipeline/pipeline-types.ts` — `NormalizedMessage`, `PipelineResult`, and `PipelineStats` type definitions
- `src/pipeline/message-normalizer.ts` — `MessageNormalizer` class: pure stateless conversion of `InboundEvent` to `NormalizedMessage`, with UUID generation and timestamp fallback
- `src/pipeline/message-pipeline.ts` — `MessagePipeline` class: full end-to-end orchestration (channel lookup → thread resolve/create → normalize → dedup → persona route → enqueue)
- `src/pipeline/index.ts` — barrel export for all pipeline types and classes

### Modified source files
- `src/core/errors/error-types.ts` — Added `PipelineError` class extending `TalonError` with code `'PIPELINE_ERROR'`
- `src/core/errors/index.ts` — Re-exported `PipelineError`

### Modified test files
- `tests/unit/core/errors/error-types.test.ts` — Added `PipelineError` to the existing error class coverage suite (imports, `describeErrorClass` call, and distinctness check)

## Tests Added

- `tests/unit/pipeline/message-normalizer.test.ts` — 14 tests covering field mapping, UUID generation, timestamp fallback, and output shape completeness
- `tests/unit/pipeline/message-pipeline.test.ts` — 33 tests covering:
  - Happy path (enqueued): all collaborators called correctly, counters updated
  - Duplicate detection: `existsByIdempotencyKey` short-circuits before insert/enqueue
  - No persona case: `Ok('no_persona')` returned, audit log written, counter updated
  - Channel not found: `Err(PipelineError)` returned for missing channel and DB error
  - Thread creation: new thread inserted when `findByExternalId` returns null, errors propagated
  - Error handling: `Err(PipelineError)` for insert failure, router failure, enqueue failure, and unexpected throws
  - Stats: initial zeroes, accumulation across multiple events, snapshot semantics

Total new tests: 56 (47 pipeline + 9 PipelineError in error-types.test.ts).
Full suite: 1197 tests, all passing.

## Deviations from Plan

- **Race-condition duplicate check removed**: The plan mentioned checking if the inserted row id differs from the generated id to catch race-condition duplicates. Since the daemon is single-process and SQLite is single-writer, true concurrent inserts are impossible. The `existsByIdempotencyKey` check before insert is sufficient and simpler. The INSERT OR IGNORE ensures DB consistency regardless.
- **AuditLogger.log() does not exist**: The task description referenced a generic `log()` method but the actual AuditLogger exposes domain-specific methods. Used `logChannelSend()` for the "message dropped, no persona" audit event, with `action: 'pipeline.message.dropped'` and `reason: 'no_persona'` in the details.

## Status

completed

## Notes

- The pipeline is fully stateless except for in-memory stats counters.
- Thread creation uses UUID v4 (consistent with the rest of the codebase).
- All error paths return `Err(PipelineError)` — never thrown.
- Duplicate detection uses `existsByIdempotencyKey` (a fast boolean read) before the INSERT OR IGNORE to distinguish new messages from duplicates at the application layer.
