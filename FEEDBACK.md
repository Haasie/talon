# Talon v1 Spec vs Implementation Review

Reviewed against `specs/talon-v1/spec.md`, `specs/talon-v1/plan.md`, and the current implementation in `src/`.

## Overall verdict

The codebase has strong building blocks and excellent test coverage, but the end-to-end daemon path is not implemented yet. Right now this looks like a **well-tested subsystem scaffold**, not a completed v1 daemon that satisfies the full functional spec.

## What is solid

- The project is modular and consistent with the planned architecture (`src/core/*`, `src/channels/*`, `src/queue/*`, `src/sandbox/*`, etc.).
- Data layer foundations are good: migration runner, repository pattern, WAL + FK pragmas (`src/core/database/connection.ts:23`, `src/core/database/migrations/runner.ts:27`).
- Queue/IPC/scheduler components are implemented with meaningful behavior and tests (`src/queue/queue-manager.ts`, `src/ipc/ipc-reader.ts`, `src/scheduler/scheduler.ts`).
- Quality bar is high on testing: `2211` tests pass (`npm test`) and build is green (`npm run build`).

## Major gaps against the spec

1. **Daemon entrypoint is not wired**

- `src/index.ts:8` only prints `talond starting...` and does not start `TalondDaemon`.
- This blocks core ACs around startup/readiness and signal-driven lifecycle in section 2.1.

2. **Core message-to-agent execution path is still placeholder**

- `src/daemon/daemon.ts:53`-`src/daemon/daemon.ts:56` has explicit TODOs for SandboxManager, PersonaLoader, SkillLoader, and MCP.
- Queue processing handler is currently a no-op (`src/daemon/daemon.ts:253`-`src/daemon/daemon.ts:256`).
- This means ACs in sections 2.2, 4.1, 9, 12, and 18 are not met end-to-end even if individual modules exist.

3. **MCP forwarding is mocked**

- `src/mcp/mcp-proxy.ts:316` states transport is placeholder, and `src/mcp/mcp-proxy.ts:334` returns `_mock: true` content.
- Spec expects host-brokered real MCP execution and failure isolation.

4. **Multi-agent run records still use placeholder IDs**

- `src/collaboration/supervisor.ts:149` and `src/collaboration/supervisor.ts:150` persist placeholder `thread_id`/`persona_id` values.
- This risks invalid lineage and breaks expected `runs` integrity for collaboration auditability.

## Spec/contract inconsistencies

1. **Status IPC payload and CLI typing are out of sync**

- Daemon status response returns fields like `uptime` and `queueStats` (`src/daemon/daemon.ts:627`-`src/daemon/daemon.ts:631`).
- CLI expects `uptimeMs`, `activeContainers`, `queueDepth`, `deadLetterCount`, etc. (`src/cli/cli-types.ts:64`-`src/cli/cli-types.ts:88`).
- Current `talonctl status` output will show missing/unknown values for several fields.

2. **Config example and runtime schema diverged**

- Example config uses `daemon.*`, `claude.*`, and snake_case keys (`config/talond.example.yaml:47`, `config/talond.example.yaml:72`).
- Runtime schema expects top-level `storage`, `sandbox`, `queue`, `logLevel`, camelCase keys (`src/core/config/config-schema.ts:143`-`src/core/config/config-schema.ts:155`).
- New users following the example file will hit validation failures.

3. **Message idempotency uniqueness differs from spec text**

- Spec says idempotency key is unique per channel (AC-3.2.3).
- DB schema uses a global unique index on `messages(idempotency_key)` (`src/core/database/migrations/001-initial-schema.sql:85`).
- Collision across channels is possible if providers reuse IDs.

4. **NPM migration script points to a non-existent file**

- `package.json:22` uses `dist/core/database/migrations/run.js`, but only `runner.ts` exists (`src/core/database/migrations/runner.ts`).

## Recommendation (priority order)

1. Wire `src/index.ts` to actually bootstrap `TalondDaemon` + signal handlers.
2. Replace daemon queue no-op with real dispatch path (pipeline/router/persona/sandbox/tool loop).
3. Resolve config drift first (schema <-> example <-> README) to prevent onboarding failures.
4. Fix status IPC contract mismatch so `talonctl status` reports real values.
5. Decide and codify idempotency scope (global vs per-channel) and align schema/tests/spec.
