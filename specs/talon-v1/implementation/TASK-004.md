# Task TASK-004: Logging and audit system with pino

## Changes Made

### New source files
- `src/core/logging/logger.ts` — `LoggerConfig` and `LogBindings` interfaces; `createLogger()` factory that creates a root pino logger with `service: 'talond'` base binding (pretty via pino-pretty transport in dev, structured JSON in production); `createChildLogger()` helper that derives a child logger from any parent with optional correlation bindings (runId, threadId, persona, tool, requestId), filtering out undefined values so they do not appear in JSON output.
- `src/core/logging/audit-logger.ts` — `AuditEntry` interface; `AuditStore` persistence interface (synchronous `append` callback, intentionally decoupled from better-sqlite3 so TASK-005 can inject a concrete implementation); `AuditLogger` class with five typed audit methods (`logToolExecution`, `logApprovalDecision`, `logChannelSend`, `logScheduleTrigger`, `logConfigReload`) that write to pino at `info` level and optionally to an `AuditStore`.

### Updated barrel
- `src/core/logging/index.ts` — exports all public symbols from `logger.ts` and `audit-logger.ts`.

## Tests Added

- `tests/unit/core/logging/logger.test.ts` — 20 tests covering:
  - `createLogger()` returns a pino instance, respects all six log levels, emits `service: 'talond'`, does not throw in pretty or JSON mode
  - JSON output: valid JSON lines, standard fields (level, msg, time), message string, extra fields
  - Log level filtering: suppression below threshold, emission at/above threshold, trace emits all
  - `createChildLogger()`: returns pino logger, all binding fields present in records, inherits `service`, omits undefined fields, works with empty bindings, inherits parent level, grandchild inherits all ancestor bindings

- `tests/unit/core/logging/audit-logger.test.ts` — 48 tests covering:
  - Construction with and without `AuditStore`
  - For each of the five audit methods: correct `msg`, `audit: true` flag, `details` payload, all optional correlation fields, omission of undefined fields, `store.append` called once with the exact entry, no-store mode does not throw, log level is `info` (30)
  - `AuditStore` callback contract: exact entry reference passed, called for every method, pino-only mode works
  - Details payload: nested objects preserved, empty object preserved

Total: 68 new tests. All 210 tests pass.

## Deviations from Plan

None. All files implemented exactly as specified. The cast `as pino.DestinationStream` on the `pino.transport()` return value was needed to satisfy the ESLint `@typescript-eslint/no-unsafe-argument` rule, as pino's type declarations type the transport return as `any`-derived `ThreadStream`.

## Status

completed

## Notes

- `AuditStore.append` is intentionally synchronous to ensure audit writes are atomic with the pino write and require no async error-recovery in `AuditLogger`.
- The `write` private method in `AuditLogger` builds a flat log object (no action field — the action is the pino `msg`) so log aggregators can filter by event type with a plain text query.
- `pino.transport()` spawns a worker thread for pino-pretty; tests do not use `createLogger({ pretty: true })` for capturing output — they construct a bare pino instance with a custom writable duck-type instead, avoiding the worker thread overhead and making output synchronously available.
