# Task TASK-018: Daemon IPC — talonctl ↔ talond Communication

## Changes Made

### New Files
- `src/ipc/daemon-ipc-server.ts` — `DaemonIpcServer` class that polls an input directory for `DaemonCommand` JSON files, dispatches them to a configurable handler, writes `DaemonResponse` files atomically to an output directory, and moves invalid files to an errors directory with companion `.error.json` annotation files.
- `src/ipc/daemon-ipc-client.ts` — `DaemonIpcClient` class with `send(command)` and `sendCommand(type, payload?)` methods that write commands atomically and poll for matching responses by `commandId`.

### Modified Files
- `src/ipc/daemon-ipc.ts` — Added re-exports of `DaemonIpcServer`, `DaemonIpcServerOptions`, `DaemonIpcClient`, and `DaemonIpcClientOptions` from the new modules.
- `src/ipc/index.ts` — Added exports for `DaemonIpcServer`, `DaemonIpcClient`, `DaemonIpcServerOptions`, and `DaemonIpcClientOptions`.
- `src/daemon/daemon.ts` — Wired up `DaemonIpcServer` in `start()` (step 13) and `stop()`. Added `private ipcServer: DaemonIpcServer | null` field. Added `handleIpcCommand()` private method that dispatches `status`, `reload`, and `shutdown` commands.

### New Test Files
- `tests/unit/ipc/daemon-ipc-server.test.ts` — 16 tests covering: empty dir, missing dir, valid command processing, file deletion, response writing, FIFO ordering, non-json file filtering, invalid JSON to errorsDir, schema-invalid to errorsDir, error annotation file creation, handler error response, multi-file continuation, start/stop lifecycle.
- `tests/unit/ipc/daemon-ipc-client.test.ts` — 10 tests covering: command file writing, matching response return, response file cleanup, timeout (null return), missing outputDir, auto-creating inputDir, failure response handling, pre-built command via `send()`, mismatched commandId, non-json file filtering.

## Tests Added
- `tests/unit/ipc/daemon-ipc-server.test.ts` — 16 tests
- `tests/unit/ipc/daemon-ipc-client.test.ts` — 10 tests
- Total suite: 1529 tests, all passing

## Deviations from Plan
- None. Implementation follows the plan exactly.
- `handleIpcCommand()` uses a dynamic `import('crypto')` for `randomUUID` (avoids a top-level import cycle concern) — this is equivalent to the static import and has no semantic difference.
- The IPC server is started at step 13 (between PID file write and marking state 'running'), consistent with the plan.

## Status
completed

## Notes
- The `DaemonIpcServer.pollOnce()` returns the processed commands even when the handler throws — the command is considered processed because the input file is deleted and an error response is written. This is intentional.
- The shutdown command handler uses `setImmediate()` to fire `this.stop()` so the IPC response can be written before the server stops polling.
- The `activeChannels` and `queueStats` fields in the status response are cast via `unknown` to satisfy the `Record<string, unknown>` constraint of `DaemonResponse.data` — they are serialisable to JSON so this is safe.
