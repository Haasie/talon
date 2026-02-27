# Task TASK-033: Token Usage Tracking

## Changes Made

### New Files
- `src/usage/usage-types.ts` — Type definitions: `TokenUsage`, `TokenUsageSummary`, `BudgetConfig`, `BudgetStatus`
- `src/usage/token-tracker.ts` — `TokenTracker` service: `recordUsage`, `getUsageByPersona`, `getUsageByThread`, `getUsageByPeriod`, `checkBudget`
- `src/usage/index.ts` — Barrel exports for the usage subsystem
- `tests/unit/usage/token-tracker.test.ts` — 23 unit tests covering all public methods

### Modified Files
- `src/core/database/repositories/run-repository.ts` — Added `TokenAggregateRow` interface and three aggregation methods: `aggregateByPersona`, `aggregateByThread`, `aggregateByPeriod`. Internal `_aggregate` helper builds parameterised SQL with optional persona/thread/time filters. The `updateTokens` method was already present.
- `src/core/database/repositories/index.ts` — Exports `TokenAggregateRow`.
- `src/cli/cli-types.ts` — Added `tokenUsage24h` optional field to `DaemonStatusData`.
- `src/cli/commands/status.ts` — `displayStatus` now renders token usage and cost when `tokenUsage24h` is present.

## Tests Added

- `tests/unit/usage/token-tracker.test.ts`
  - 23 tests, 100% coverage of all `TokenTracker` methods
  - Uses real in-memory SQLite with migrations applied
  - Covers: recordUsage write-through, aggregation per persona/thread/period, time-range filtering, cross-persona isolation, exclusion of non-completed runs, budget within/warning/exceeded paths, default warn threshold, periodEnd override, cache tokens excluded from budget

## Deviations from Plan

None. All implementation follows the spec exactly.

## Status

completed

## Notes

- `_aggregate` uses a single parameterised SQL helper to keep all three aggregation methods DRY. Conditions are built dynamically and the prepared statement is created inline (not cached on the class) because the filter set varies per call.
- Cache tokens (`cache_read_tokens + cache_write_tokens`) are intentionally excluded from the budget token count — only `input_tokens + output_tokens` are counted against the quota, matching the spec's definition of "total tokens (input + output)".
- The `warningTriggered` flag is `false` when over budget (only fires when still within budget but approaching the threshold).
