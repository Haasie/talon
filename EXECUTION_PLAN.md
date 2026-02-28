# Talon v1 Execution Plan

Based on `FEEDBACK.md`, this plan prioritizes getting the real daemon path working first, then closing contract drift and hardening.

## Assumptions

- Estimates are engineering time (implementation + local validation), not calendar time.
- 1 engineer, full-time focus, minimal scope creep.
- No major architecture rewrites beyond what is already in the codebase.

## Phase 1 — Make the daemon actually run end-to-end (highest priority)

### TASK-001: Wire real daemon bootstrap

- Scope: Implement `src/index.ts` to load logger/config path args, instantiate `TalondDaemon`, call `start()`, install `setupSignalHandlers`, and handle startup errors.
- Deliverables:
  - Functional process entrypoint replacing current `console.log` stub.
  - Clear exit codes and startup logs.
- Estimate: **4-6 hours**

### TASK-002: Replace queue no-op with real dispatch path

- Scope: In `src/daemon/daemon.ts`, replace placeholder queue handler with real orchestration: queue item -> thread/persona resolution -> sandbox dispatch -> run status update -> completion/failure handling.
- Deliverables:
  - No-op handler removed.
  - Queue items produce real work and side effects.
- Estimate: **2-3 days**

### TASK-003: Integrate missing core subsystems into daemon lifecycle

- Scope: Wire `SandboxManager`, `PersonaLoader`, `SkillLoader`, and MCP registry/proxy into startup/reload/shutdown path where TODOs currently exist.
- Deliverables:
  - TODO blocks in `src/daemon/daemon.ts` resolved.
  - Clean startup/shutdown ordering for these components.
- Estimate: **2-3 days**

## Phase 2 — Fix contract drift and user-facing correctness

### TASK-004: Align status IPC response contract

- Scope: Unify `talond` status payload and `talonctl` expectations (`DaemonHealth` mapping vs `DaemonStatusData`), including queue and channel counts.
- Deliverables:
  - `talonctl status` displays accurate, non-unknown values.
  - Shared types reflect actual payload.
- Estimate: **6-10 hours**

### TASK-005: Resolve config schema/example/README mismatch

- Scope: Choose a canonical config shape, then align:
  - `src/core/config/config-schema.ts`
  - `config/talond.example.yaml`
  - README config sections/examples.
- Deliverables:
  - Example config validates out-of-the-box.
  - Docs and runtime schema describe the same keys.
- Estimate: **1.5-2.5 days**

### TASK-006: Fix broken npm migration script target

- Scope: Update `package.json` migrate script to call an existing CLI path.
- Deliverables:
  - `npm run migrate` works from clean install.
- Estimate: **1-2 hours**

## Phase 3 — Security/persistence correctness gaps

### TASK-007: Implement real MCP call forwarding

- Scope: Replace mock `_mock: true` response in `src/mcp/mcp-proxy.ts` with real transport call path while preserving policy checks and failure isolation.
- Deliverables:
  - Real MCP server invocation and structured result mapping.
  - Retry/timeout/error handling that cannot crash daemon.
- Estimate: **2-4 days**

### TASK-008: Fix collaboration placeholder IDs in persisted child runs

- Scope: Replace placeholder thread/persona IDs in `src/collaboration/supervisor.ts` with resolved canonical IDs before insert.
- Deliverables:
  - Valid `runs.parent_run_id`, `thread_id`, and `persona_id` integrity.
  - Accurate audit/queryability for child runs.
- Estimate: **6-10 hours**

### TASK-009: Reconcile idempotency uniqueness semantics

- Scope: Decide whether idempotency is global or per-channel; align migration schema, repository behavior, and docs/spec references.
- Deliverables:
  - Explicit rule implemented and documented.
  - Matching DB index strategy.
- Estimate: **4-8 hours**

## Phase 4 — Validation and release readiness

### TASK-010: Add targeted integration tests for new end-to-end path

- Scope: Add/extend integration coverage for daemon bootstrap, queue dispatch real path, status IPC contract, and config compatibility.
- Deliverables:
  - Tests covering the new wiring points and regressions called out in feedback.
- Estimate: **1.5-2.5 days**

### TASK-011: Update release docs and operator runbook

- Scope: Update README and operational docs for startup, migrate, reload, and troubleshooting based on final behavior.
- Deliverables:
  - Accurate command docs.
  - Basic “known failure modes + fixes” section.
- Estimate: **4-8 hours**

## Dependency order

1. TASK-001 -> TASK-002 -> TASK-003 (critical path)
2. TASK-004 and TASK-006 can run in parallel once TASK-001 is done.
3. TASK-005 should start after deciding canonical config approach (can overlap with TASK-003 late).
4. TASK-007 and TASK-008 depend on TASK-003 baseline wiring.
5. TASK-010 after core tasks land; TASK-011 last.

## Rough total estimate

- **Core critical path (Phase 1 + key drift fixes): ~8-12 engineering days**
- **Full plan including MCP hardening + validation/docs: ~13-20 engineering days**

## Suggested first sprint slice (5 days)

1. TASK-001
2. TASK-002 (initial working path)
3. TASK-004
4. TASK-006

This yields a running daemon with real queue execution and a trustworthy `talonctl status` baseline, which unblocks the rest.
