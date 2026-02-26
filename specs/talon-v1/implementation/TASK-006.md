# Task TASK-006: IPC system — atomic writer, directory poller, message types

## Changes Made

### New source files

- `src/ipc/ipc-types.ts` — Zod schemas and TypeScript types for all 8 IPC message
  types (message.new, message.send, tool.request, tool.result, memory.read,
  memory.write, artifact.put, shutdown) plus the discriminated union
  `IpcMessageSchema` / `IpcMessage`.

- `src/ipc/ipc-writer.ts` — `IpcWriter` class with synchronous `write()` (uses
  `writeFileAtomic.sync`) and async `writeAsync()`. Files are named
  `{15-digit-padded-timestamp}-{uuid-no-hyphens}.json` for lexicographic FIFO
  ordering. Returns `Result<string, IpcError>` from neverthrow. Exported
  `buildFilename()` helper for use in tests.

- `src/ipc/ipc-reader.ts` — `IpcReader` class that polls a directory via
  `setInterval`, sorts files lexicographically, validates each with
  `IpcMessageSchema`, dispatches to a handler, and deletes processed files.
  Invalid JSON, schema failures, and handler errors all result in the file being
  quarantined to `errorsDir` with a companion `.error.json` annotation.
  `pollOnce()` is the testable unit; `start()` / `stop()` wrap the interval.

- `src/ipc/ipc-channel.ts` — `BidirectionalIpcChannel` composes `IpcWriter`
  (outbound) and `IpcReader` (inbound) into a single start/send/stop interface.

- `src/ipc/daemon-ipc.ts` — `DaemonCommand` and `DaemonResponse` interfaces
  plus Zod schemas for the talonctl <-> talond control protocol.

### Modified source files

- `src/ipc/index.ts` — Replaced stub `export {}` with full barrel re-exporting
  all public types, schemas, classes, and helpers from the five new modules.

## Tests Added

- `tests/unit/ipc/ipc-writer.test.ts` (16 tests)
  - `buildFilename()`: padding, ID embedding, format, lexicographic ordering
  - `write()`: creates file, returns correct filename, valid JSON content,
    round-trips through schema, creates missing directory, distinct filenames
    for distinct messages, returns Err on write failure
  - `writeAsync()`: creates file, creates missing directory, valid JSON,
    returns Err on failure

- `tests/unit/ipc/ipc-reader.test.ts` (15 tests)
  - `pollOnce()`: empty dir, nonexistent dir, single valid message, file
    deletion, FIFO order, non-.json file filtering, handler invocation
  - Invalid handling: bad JSON, schema failure, `.error.json` companion file,
    handler throw, continues after bad file
  - `start()` / `stop()`: polling works, stop is idempotent, second start is no-op

- `tests/unit/ipc/ipc-channel.test.ts` (7 tests)
  - Construction, `send()` writes to outputDir, content round-trips through
    schema, start/stop polling, bidirectional simultaneous send/receive, safe
    stop when not started

- `tests/integration/ipc.test.ts` (13 tests)
  - Full write + pollOnce round-trip with file creation and deletion verification
  - One test per message type (8 types)
  - FIFO ordering with 3 messages written in reverse timestamp order
  - Invalid JSON quarantine with valid message continuing to process
  - BidirectionalIpcChannel end-to-end with real filesystem polling
  - Async writer + pollOnce round-trip

Total new tests: 51 (all passing alongside the pre-existing 142).

## Deviations from Plan

- `IpcWriter.write()` is synchronous (uses `writeFileAtomic.sync`) rather than
  returning a `Promise<Result>`. The `writeAsync()` async variant is provided
  as a convenience method. This keeps the `send()` call on
  `BidirectionalIpcChannel` synchronous which is more ergonomic for callers that
  do not need to await acknowledgement of each write.

- `IpcReader` uses `setInterval` rather than a recursive `setTimeout` chain.
  For the 500 ms default this is fine; if a poll takes longer than the interval
  there will be overlapping polls. Given single-threaded Node.js and the
  lightweight nature of each poll this is acceptable. A guard flag can be added
  as a follow-up if needed.

## Status

completed

## Notes

- All 193 tests pass (`npm test`), `npm run build` succeeds, `npm run lint`
  produces no warnings or errors.
- The `require('fs')` calls in writer tests use CommonJS-style require which
  works because Vitest transforms the test files and `fs` is a Node built-in.
  These are isolated to test helpers creating blocking files for error-path tests.
