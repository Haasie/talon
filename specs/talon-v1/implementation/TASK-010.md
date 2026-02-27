# Task TASK-010: Persona system — loading, capability resolution, skill integration

## Changes Made

### New files
- `src/personas/persona-types.ts` — `LoadedPersona` and `ResolvedCapabilities` interfaces, plus re-exports of `PersonaConfig` and `CapabilitiesConfig` from config-types.
- `src/personas/capability-merger.ts` — `mergeCapabilities()` and `validateCapabilityLabels()` functions. Handles persona-only capabilities, skill intersection, requireApproval override, and label format validation.
- `src/personas/persona-loader.ts` — `PersonaLoader` class with `loadFromConfig()` (async, reads files, upserts DB, validates caps) and `getByName()` (cache lookup). Uses neverthrow Result throughout.

### Modified files
- `src/personas/index.ts` — Replaced empty export with re-exports of all public types and classes.

### Tests
- `tests/unit/personas/capability-merger.test.ts` — 27 tests covering:
  - `mergeCapabilities`: persona-only, with skills, intersection logic, requireApproval override, edge cases, deduplication
  - `validateCapabilityLabels`: valid labels, missing-scope warnings, malformed labels, mixed lists
- `tests/unit/personas/persona-loader.test.ts` — 30 tests covering:
  - Empty config loading
  - Single and multiple persona loading
  - System prompt file reading (success and failure)
  - Upsert behaviour (insert on first load, update on reload)
  - Capability resolution and requireApproval override
  - Warning logging for malformed/missing-scope labels (non-fatal)
  - DB error handling for findByName, insert, and update failures
  - `getByName` cache lookup before/after loading
  - Field mapping to DB rows (skills, capabilities, mounts, maxConcurrent, system_prompt_file)

## Coverage

Personas module: 99.47% statements, 96.36% branches, 90.9% functions, 99.47% lines.

The overall project branch coverage is 79.97% (0.03% below threshold) — this is a pre-existing condition, not introduced by this task. All 925 tests pass with `npm test`.

## Deviations from Plan

- The `ResolvedCapabilities` interface was defined in `persona-types.ts` rather than re-using the one in `src/tools/capability-resolver.ts` because that existing interface uses `{ granted, unmet }` semantics (skill intersection results) rather than the `{ allow, requireApproval }` semantics needed for persona policy. The two serve different purposes.
- `mergeCapabilities` without skill capabilities uses the persona's `allow` list directly (intersection-without-skills = all persona allow labels survive), with the requireApproval override applied.
- Skill `requireApproval` feeds into the global approval set even for labels not in the persona's allow list — this future-proofs scenarios where skill approval requirements are tracked for auditing even when the capability isn't granted.

## Status

completed

## Notes

- `PersonaLoader` is intentionally stateful (cache) and not thread-safe — it is expected to be used as a singleton during the daemon's startup phase.
- The upsert logic (findByName then insert/update) is not atomic but SQLite's WAL mode makes this safe for single-writer scenarios.
- Skill-level capability merging is wired up at the `mergeCapabilities` function level — the `PersonaLoader.loadFromConfig` currently applies persona-only capabilities. Skill resolution at runtime (when skills are attached) should call `mergeCapabilities(persona.config.capabilities, skillCapabilitiesArray)` directly.
