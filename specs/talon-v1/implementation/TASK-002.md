# Task TASK-002: Core types, error types, and Result helpers

## Changes Made

### New source files
- `src/core/types/common.ts` — UUID branded type, `createUuid()`, `isUuid()`, `Timestamp`, `now()`, `toIsoString()`, `fromIsoString()`
- `src/core/types/result.ts` — Re-exports neverthrow primitives plus `okVoid()`, `errFromError()`, `resultFromPromise()`
- `src/core/errors/error-types.ts` — `TalonError` abstract base class plus 12 domain-specific subclasses
- `src/core/errors/error-codes.ts` — `ErrorCodes` constant object and `ErrorCode` union type

### Updated barrel exports
- `src/core/types/index.ts` — exports common.ts and result.ts symbols
- `src/core/errors/index.ts` — exports error-types.ts and error-codes.ts symbols

## Tests Added

- `tests/unit/core/types/common.test.ts` — 21 tests covering UUID generation, isUuid type guard, and all timestamp helpers
- `tests/unit/core/types/result.test.ts` — 11 tests covering okVoid, errFromError, resultFromPromise, and neverthrow re-exports
- `tests/unit/core/errors/error-types.test.ts` — 110 tests covering all 12 error classes (instanceof chain, message, code, name, cause, stack) plus cross-cutting uniqueness check

Total: 142 tests, all passing.

## Deviations from Plan

None. All files implemented exactly as specified.

## Notes

- `isUuid()` accepts only lowercase UUID v4 (version digit 4, variant nibble 8/9/a/b). Uppercase UUIDs are rejected. This is consistent with the output of the `uuid` package.
- `fromIsoString()` throws `RangeError` (not a TalonError) because it is a pure utility function that should only receive valid ISO strings at runtime. Invalid input is a programming error, not a domain error.
- The `cause` field on `TalonError` shadows the built-in `Error.cause` property (introduced in ES2022). Both point to the same value, so existing tooling that reads `Error.cause` will see the correct value.

## Status

completed
