# Task TASK-032: talonctl Setup and Add Commands

## Changes Made

### New Files
- `src/cli/commands/setup.ts` — First-time setup command with 7 structured checks: OS detection, Node.js version, Docker availability, data directory creation, config generation, database migrations, and config validation. Exports `SetupCheck`/`SetupStatus` types, individual check functions, and `runSetupChecks`/`displaySetupResult` for testability.
- `src/cli/commands/add-channel.ts` — Reads talond.yaml, validates channel name uniqueness, appends a new channel entry with a type-specific placeholder config, writes back. Supports telegram, slack, discord, whatsapp, and email with sensible placeholder fields.
- `src/cli/commands/add-persona.ts` — Scaffolds `personas/{name}/` directory with a `system.md` template, then adds a persona entry (model, systemPromptFile, empty skills/capabilities) to the `personas` array in talond.yaml.
- `src/cli/commands/add-skill.ts` — Scaffolds `skills/{name}/` directory with `prompts/` subdirectory and a `skill.yaml` manifest stub, then adds the skill name to the specified persona's `skills` list in talond.yaml.

### Modified Files
- `src/cli/index.ts` — Registered four new sub-commands: `setup`, `add-channel`, `add-persona`, `add-skill` with appropriate options and action handlers.

## Tests Added

- `tests/unit/cli/setup.test.ts` — 40 tests covering all individual check functions, `runSetupChecks` integration, and `displaySetupResult` display helper.
- `tests/unit/cli/add-channel.test.ts` — 9 tests covering adding channels, duplicate rejection, placeholder config shapes, and error handling.
- `tests/unit/cli/add-persona.test.ts` — 11 tests covering directory scaffolding, system.md creation, config updates, duplicate rejection, and idempotent file handling.
- `tests/unit/cli/add-skill.test.ts` — 11 tests covering skill directory creation, manifest generation, persona skill list updates, duplicate/missing-persona errors, and idempotent manifest handling.

Total: 71 new tests. All 1636 tests in the suite pass.

## Deviations from Plan

None. All four commands and tests were implemented as specified. The `yaml` package used is `js-yaml` (already available as a dependency — the task description refers to it as "the `yaml` package").

The `setup.ts` command uses `js-yaml` for config file generation (consistent with the rest of the codebase which uses `js-yaml`), not the `yaml` package.

## Status

completed

## Notes

- All check/step functions in `setup.ts` are exported for unit testing (same pattern as `doctor.ts`).
- `add-persona` and `add-skill` accept `personasDir`/`skillsDir` override options for testing, following the same pattern as `migrationsDir` in `migrate.ts`.
- The setup command generates a `talond.yaml` from a plain object (not from the example YAML file), ensuring the output always matches the current config schema defaults.
- Docker check in setup uses `docker info` (as specified) rather than `docker version` (which doctor uses) — both are reasonable; `docker info` verifies daemon connectivity more directly.
