# Task TASK-017: talonctl CLI — status, migrate, backup, reload, doctor

## Changes Made

### New source files

- `src/cli/cli-types.ts` — Type definitions for CLI commands and responses (DoctorCheck, DoctorResult, MigrateResult, BackupResult, DaemonStatusData, DaemonReloadData, CliError)
- `src/cli/commands/status.ts` — Sends `status` IPC command to daemon input directory, polls output for response, displays health table
- `src/cli/commands/migrate.ts` — Standalone migrate command; loads config, opens DB, calls `runMigrations()`
- `src/cli/commands/backup.ts` — Standalone backup command; uses SQLite `VACUUM INTO` for atomic backup
- `src/cli/commands/reload.ts` — Sends `reload` IPC command to daemon, polls for response, reports what was reloaded
- `src/cli/commands/doctor.ts` — Standalone doctor command; checks Node.js version, Docker, config validity, DB access, data directories
- `bin/talonctl.js` — Bin entry point for npm package installation

### Modified source files

- `src/cli/index.ts` — Replaced placeholder with full commander setup: status, migrate, backup, reload, doctor subcommands with options
- `package.json` — Added `bin.talonctl` pointing to `bin/talonctl.js`

### New test files

- `tests/unit/cli/doctor.test.ts` — 27 tests covering all individual doctor checks, display, and integration
- `tests/unit/cli/migrate.test.ts` — 6 tests covering migration success, no-op, config errors, SQL errors
- `tests/unit/cli/backup.test.ts` — 7 tests covering backup file creation, valid SQLite output, directory creation, default path
- `tests/unit/cli/status.test.ts` — 4 tests covering timeout, command file written, successful response, error response
- `tests/unit/cli/reload.test.ts` — 4 tests covering timeout, command file written, successful response, error response
- `tests/unit/cli/cli-registration.test.ts` — 12 tests verifying all command exports, CliError class, result type shapes

## Tests Added

All tests in `tests/unit/cli/`:
- 60 new tests across 6 test files
- Doctor command: mocked Node version check, real filesystem for config/DB checks
- Migrate: real temporary databases and migrations dirs
- Backup: real SQLite databases, verifies backup data integrity
- Status/Reload: uses `fs.watch` to simulate daemon responses via IPC

## Deviations from Plan

1. `migrateCommand` was implemented as synchronous (not `async`) since all underlying calls (`loadConfig`, `createDatabase`, `runMigrations`) are synchronous. The commander action wrapper handles this correctly.

2. Added `return` statements after `process.exit(1)` calls throughout all commands to ensure correct control flow when `process.exit` is mocked in tests.

3. Did not add `npm install commander` since `commander` was already in `package.json` dependencies.

4. Coverage threshold failure (branch coverage 78.42% < 80%) is pre-existing and caused by the queue module (72.22% branches), not by the new CLI code. CLI modules have 88-100% line coverage.

## Status

completed

## Notes

- The status and reload commands write commands atomically to `data/ipc/daemon/input/` and poll `data/ipc/daemon/output/` for matching responses by `commandId`
- The doctor command's `runDoctorChecks()` function is exported separately to enable testing without `process.exit` side effects
- The backup command uses SQLite's `VACUUM INTO` which creates a consistent, atomic copy even if the source DB has WAL mode enabled
- All commands follow the `return` after `process.exit()` pattern for testability under mocked exits
