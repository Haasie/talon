# Task TASK-009: Tool system — registry, capability resolver, policy engine

## Changes Made

### New files
- `src/tools/tool-types.ts` — Core type definitions: `ExecutionLocation`, `ToolManifest`, `PolicyDecision`, `ToolCallRequest`, `ToolCallResult`
- `src/tools/tool-registry.ts` — `ToolRegistry` class with `register`, `unregister`, `get`, `listAll`, `listByCapability`, `listByLocation`
- `src/tools/capability-resolver.ts` — `resolveCapabilities` (persona ∩ skills intersection), `hasCapability`, `isValidCapabilityLabel` with regex validation
- `src/tools/policy-engine.ts` — `PolicyEngine.evaluate()` implementing the 4-step decision algorithm (missing grant → deny, requireApproval → require_approval, all allowed → allow, default → deny)
- `src/tools/approval-gate.ts` — Placeholder `ApprovalGate` returning `'denied'` (full implementation TASK-028)
- `src/tools/host-tools/channel-send.ts` — Type stub for channel.send tool
- `src/tools/host-tools/schedule-manage.ts` — Type stub for schedule.manage tool
- `src/tools/host-tools/memory-access.ts` — Type stub for memory.access tool
- `src/tools/host-tools/http-proxy.ts` — Type stub for net.http proxy tool
- `src/tools/host-tools/db-query.ts` — Type stub for db.query tool

### Modified files
- `src/tools/host-tools/index.ts` — Updated barrel to export all stub types
- `src/tools/index.ts` — Updated barrel to export all tool system types and classes

## Tests Added

- `tests/unit/tools/tool-registry.test.ts` — 32 tests covering initial state, register, unregister, get, listAll, listByCapability, listByLocation, and edge cases (duplicates, empty registry, partial matches)
- `tests/unit/tools/capability-resolver.test.ts` — 37 tests covering resolveCapabilities (full/partial/none intersection, empty inputs, duplicates), hasCapability, and isValidCapabilityLabel (valid and invalid label patterns)
- `tests/unit/tools/policy-engine.test.ts` — 20 tests covering allow, deny (missing grant), deny (default), require_approval, priority ordering (deny > require_approval > allow), and multi-capability scenarios

Total: 89 new tests, all passing.

## Deviations from Plan

- The plan (section 3.7) describes a `CapabilitySet` with `Set<string>` members and a `createPolicyHook` function integrated with SDK hooks. The task spec requests a class-based `PolicyEngine.evaluate()` method with array inputs, which is more testable and decoupled from the SDK hooks layer. The SDK hook integration can wrap `PolicyEngine` in a future task when the SDK integration is built.

- `isValidCapabilityLabel` uses `\w+` (word characters: `[a-zA-Z0-9_]`) for each segment. Hyphens are explicitly rejected to keep labels simple and consistent.

- `ApprovalGate.requestApproval` was changed from `async` to returning `Promise.resolve('denied')` to satisfy the `@typescript-eslint/require-await` lint rule while maintaining the `Promise<ApprovalOutcome>` return type.

## Status

completed

## Notes

- The `better-sqlite3` native binding failures in the test suite are pre-existing (not caused by this task) — they affect database-related tests that require native compilation.
- All 89 new tool tests pass cleanly.
- Build and lint pass with zero errors.
