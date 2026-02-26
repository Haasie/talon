# Task TASK-003: Configuration system: Zod schemas, YAML loader, typed config

## Changes Made

### New files
- `src/core/config/config-schema.ts` — All Zod schemas with sensible defaults:
  - `StorageConfigSchema` (sqlite, path)
  - `SandboxConfigSchema` (runtime, image, maxConcurrent, networkDefault, timeouts, resourceLimits)
  - `CapabilitiesSchema` (allow, requireApproval)
  - `MountConfigSchema` (source, target, mode: ro/rw)
  - `PersonaConfigSchema` (name, model, systemPromptFile, skills, capabilities, mounts, maxConcurrent)
  - `ChannelConfigSchema` (type, name, config, tokenRef, enabled)
  - `ScheduleConfigSchema` (name, personaName, threadId, type, expression, payload, enabled)
  - `IpcConfigSchema` (pollIntervalMs, daemonSocketDir)
  - `QueueConfigSchema` (maxAttempts, backoffBaseMs, backoffMaxMs, concurrencyLimit)
  - `SchedulerConfigSchema` (tickIntervalMs)
  - `AuthConfigSchema` (mode: subscription/api_key, apiKey)
  - `TalondConfigSchema` — root schema combining all of the above plus logLevel, dataDir

- `src/core/config/config-types.ts` — TypeScript types inferred from all Zod schemas

- `src/core/config/config-loader.ts` — YAML loading and validation:
  - `loadConfig(filePath)` — reads a YAML file, validates, returns frozen TalondConfig or ConfigError
  - `loadConfigFromString(yaml)` — parses a YAML string, validates, returns frozen TalondConfig or ConfigError
  - `validateConfig(raw)` — validates a plain object (for talonctl doctor)
  - Deep freeze applied recursively to ensure immutability at runtime
  - Clear, actionable error messages showing which field failed validation (e.g. `sandbox.maxConcurrent: Number must be greater than or equal to 1`)

### Modified files
- `src/core/config/index.ts` — Updated barrel to export all loader functions, schemas, and types

### Test files
- `tests/unit/core/config/config-schema.test.ts` — 47 tests covering every schema:
  - Valid/invalid inputs for each schema
  - Default value verification
  - Boundary conditions (min values, enum validation)

- `tests/unit/core/config/config-loader.test.ts` — 29 tests covering:
  - Loading from YAML string (valid, empty, invalid syntax, schema violations)
  - Loading from file (valid, missing file, invalid YAML, schema violations)
  - Frozen output verification (root object and nested objects/arrays)
  - `validateConfig` function
  - Error message content (field paths included)
  - Extra/unknown fields stripped

## Tests Added
- `tests/unit/core/config/config-schema.test.ts` (47 tests)
- `tests/unit/core/config/config-loader.test.ts` (29 tests)
- Total: 76 new tests; 218 tests passing overall

## Deviations from Plan
- `AuthConfigSchema` was added to `TalondConfigSchema` as specified in the task description, even though the plan.md code sketch omits it. It's referenced in spec.md and plan.md prose.
- `loadConfig` is implemented as synchronous (using `readFileSync`) rather than async as shown in the plan.md sketch. The task specification shows `Result<TalondConfig, ConfigError>` (not `Promise<Result<...>>`), which matches the synchronous approach. Config loading happens once at startup, so sync I/O is acceptable and simpler.
- `deepFreeze` is implemented recursively rather than using `Object.freeze` shallowly, to ensure nested objects cannot be mutated.

## Status
completed

## Notes
- The `deepFreeze` helper uses explicit array element casting to `unknown[]` to satisfy the `@typescript-eslint/no-unsafe-return` rule on array items.
- Error messages include up to 5 Zod issues with paths joined by `.` for actionability, e.g. `Configuration validation failed for "/etc/talon.yaml": sandbox.maxConcurrent: Number must be greater than or equal to 1`.
