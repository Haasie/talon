# Talon v1 — Technology Research & Codebase Analysis

> Date: 2026-02-26
> Status: Complete
> Author: Architect Agent

---

## 1. Codebase Analysis

This is a **greenfield project**. No source code, no `package.json`, no `tsconfig.json` exist yet. The repository contains only:

- `AUTONOMOUS_AGENT_DESIGN.md` — authoritative architecture document
- `.claudecraft/` — ClaudeCraft scaffolding (constitution, config, specs DB)
- `.claude/` — Claude Code agents, commands, hooks, skills
- `specs/talon-v1/spec.md` — approved functional specification

**Implication:** All project structure, tooling, and conventions must be established from scratch. There are no existing patterns to follow beyond what the constitution prescribes.

---

## 2. Core Technology Stack Evaluation

### 2.1 TypeScript + Node.js

- **Version target:** Node.js 22+ (LTS), TypeScript 5.5+ (strict mode)
- **Rationale:** Constitution mandates TypeScript strict mode, Node.js single-threaded event loop
- **Key consideration:** The Agent SDK spawns child processes (Claude Code CLI), so talond's event loop must remain responsive. All sandbox management and IPC must be async/non-blocking.
- **ES Module vs CommonJS:** Use ESM (`"type": "module"` in package.json). The Agent SDK and modern tooling (vitest, pino) all support ESM natively.

### 2.2 `@anthropic-ai/claude-agent-sdk`

**What it provides:**
- `query()` — primary function; creates an async generator streaming `SDKMessage` objects
- `unstable_v2_createSession()` / `unstable_v2_resumeSession()` — V2 session-based API (preview)
- Built-in tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task (subagents)
- Hook system: PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, SubagentStart, SubagentStop, Notification, PermissionRequest, PreCompact
- MCP server integration: stdio, SSE, HTTP, and in-process SDK servers
- Session persistence and resumption via session IDs
- `canUseTool` callback — custom permission function
- `permissionMode` — default, acceptEdits, bypassPermissions, plan, dontAsk
- `spawnClaudeCodeProcess` — custom function to run Claude Code in containers
- Subagent definitions via `agents` option (with per-agent tools, model, MCP, skills)
- `systemPrompt` — custom string or `{ type: 'preset', preset: 'claude_code' }`
- `allowedTools` / `disallowedTools` — fine-grained tool control
- `maxTurns`, `maxBudgetUsd` — execution limits
- Structured output support via `outputFormat`

**Critical architectural insight — the SDK IS the agent runtime:**
The Agent SDK does NOT run as a library inside our code. It spawns a separate Claude Code CLI process. The `query()` function communicates with this child process via IPC. This means:

1. **Each sandbox IS a Claude Code process** — we do not need to build our own agent loop, prompt assembly, or tool execution. The SDK handles all of that.
2. **The `spawnClaudeCodeProcess` option** is how we run agents inside Docker containers. We override the default local spawning to instead exec into a Docker container.
3. **Context window management** is handled by the SDK (compaction, working set management). talond does NOT manage prompt assembly.
4. **Session resumption** provides context continuity across messages within the same thread. We store the sessionId per thread and resume on follow-up messages.

**V1 vs V2 API decision:**
- V2 (`unstable_v2_createSession`) is simpler for multi-turn conversations (explicit send/stream pattern)
- V2 is marked unstable/preview — APIs may change
- **Decision:** Use V1 `query()` API for stability. The async generator pattern is more complex but production-ready. We can migrate to V2 when it stabilizes.

**Key integration pattern for talond:**
```
talond receives message
  -> resolve thread + persona
  -> check if warm SDK session exists for thread
  -> if yes: stream new message into existing query via streamInput()
  -> if no: create new query() with spawnClaudeCodeProcess pointing at Docker
  -> install hooks for: policy enforcement, audit logging, IPC tool proxying
  -> process SDKMessage stream: extract outbound messages, tool results, completion
```

**Hooks are the primary policy enforcement mechanism:**
- `PreToolUse` hooks inspect every tool call before execution
- Return `deny` to block, `allow` to approve, `ask` to defer
- `canUseTool` provides even more fine-grained control per tool+input
- We implement capability-based auth entirely through hooks + canUseTool

### 2.3 `better-sqlite3`

- **Version:** 11.x (current), synchronous API (appropriate for Node.js single-threaded model)
- **WAL mode:** Essential for concurrent reads during writes. Set `PRAGMA journal_mode = WAL` on open.
- **Foreign keys:** `PRAGMA foreign_keys = ON` per the spec
- **Busy timeout:** Set `PRAGMA busy_timeout = 5000` for lock contention
- **Thread safety:** better-sqlite3 is synchronous and runs on the main thread. This is fine for SQLite where queries are fast, but we must avoid long-running queries that block the event loop.
- **Migration strategy:** Simple versioned SQL files, tracked via `PRAGMA user_version`. No migration library needed — we implement a minimal migration runner (~50 lines).

### 2.4 `pino`

- **Version:** 9.x (current)
- **Usage:** Structured JSON logging with child loggers per context (run, thread, persona)
- **Pattern:** Create a root logger, then derive child loggers with context:
  ```typescript
  const threadLog = rootLogger.child({ threadId, personaId });
  const runLog = threadLog.child({ runId });
  ```
- **Transport:** pino-pretty for development, raw JSON for production
- **Audit logging:** Separate from operational logging. Audit entries go to both the DB `audit_log` table and pino (for real-time streaming). The DB is the source of truth.

### 2.5 `neverthrow`

- **Version:** 8.x (current)
- **Pattern:** All functions that can fail return `Result<T, E>` or `ResultAsync<T, E>`
- **Error types:** Define domain-specific error enums/unions (not string errors)
- **Boundary:** At system boundaries (HTTP handlers, CLI commands, IPC message handlers), unwrap Results and convert to appropriate responses
- **Key types:** `ok()`, `err()`, `Result<T, E>`, `ResultAsync<T, E>`, `.andThen()`, `.map()`, `.mapErr()`
- **Convention:** Never throw in business logic. Use try/catch only at the outermost boundary to catch truly unexpected errors.

### 2.6 Vitest

- **Version:** 3.x (current)
- **Configuration:** `vitest.config.ts` with TypeScript path aliases
- **Coverage:** c8/v8 provider, 80% minimum enforced
- **Test types:**
  - Unit tests: `*.test.ts` co-located with source
  - Integration tests: `tests/integration/*.test.ts`
  - Contract tests: Plugin interface compliance
  - Policy tests: Capability resolution, tool gating
- **Mocking:** vitest built-in mocking for external dependencies (Docker, SDK, filesystem)

### 2.7 Zod

- **Version:** 3.x (stable)
- **Usage:** Config schema validation, IPC message validation, tool argument validation
- **Pattern:** Define Zod schemas, infer TypeScript types from them (`z.infer<typeof schema>`)
- **YAML integration:** Parse YAML with `js-yaml`, then validate with Zod
- **Key advantage:** Runtime validation + static type inference from a single schema definition

### 2.8 Dockerode

- **Version:** 4.x (current)
- **Usage:** Programmatic Docker container management from Node.js
- **Key operations:**
  - `docker.createContainer()` — create with security options
  - `container.start()` / `container.stop()` / `container.kill()`
  - `container.inspect()` — health checks, state
  - `container.attach()` — stdin for secrets delivery
  - Stream-based APIs for logs and exec
- **Alternative considered:** Direct `docker` CLI via child_process. Rejected — dockerode provides typed APIs and proper error handling.
- **Connection:** Default Unix socket `/var/run/docker.sock`. For rootless Docker: `$XDG_RUNTIME_DIR/docker.sock`.
- **Key challenge:** The Agent SDK's `spawnClaudeCodeProcess` expects to spawn a local process. We need to either:
  1. Have the SDK process run ON THE HOST and use Docker only for tool sandboxing, OR
  2. Run the entire Claude Code process INSIDE a Docker container

  **Decision:** Option 2 — run the entire Claude Code CLI inside the Docker container. Use `spawnClaudeCodeProcess` to execute `docker exec` or `docker run` instead of local process spawn. This provides full isolation. The host talond process communicates with the containerized agent via the SDK's own IPC (stdin/stdout of the spawned process) and file-based IPC for tool requests.

  **Revised understanding:** Actually, looking at the SDK more carefully, `spawnClaudeCodeProcess` receives `SpawnOptions` and must return a `SpawnedProcess` (with stdin/stdout/stderr streams). We implement this by spawning `docker exec -i <container> node /app/claude-agent-entrypoint.js` and wiring up the streams. The SDK handles all communication over these streams.

---

## 3. File-based IPC Implementation

### 3.1 Atomic Write Pattern

```typescript
// Write: temp file -> fsync -> atomic rename
import { writeFile, rename, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function atomicWrite(dir: string, message: IpcMessage): Promise<void> {
  const filename = `${Date.now()}-${randomUUID()}.json`;
  const tempPath = path.join(dir, `.tmp-${filename}`);
  const finalPath = path.join(dir, filename);
  
  const fd = await open(tempPath, 'w');
  await fd.write(JSON.stringify(message));
  await fd.datasync(); // ensure data hits disk
  await fd.close();
  await rename(tempPath, finalPath); // atomic on same filesystem
}
```

### 3.2 Polling Strategy

- Use `fs.watch()` (inotify on Linux) as primary notification mechanism
- Fall back to periodic `readdir()` polling at configurable interval (500ms default)
- `fs.watch()` is unreliable across Docker bind mounts on some platforms, so polling is the fallback
- Process files in sorted order (timestamp prefix ensures FIFO)
- Delete after successful processing; move to `errors/` on failure

### 3.3 Message Serialization

- JSON format with Zod schema validation on both sides
- File naming: `{timestamp}-{uuid}.json` ensures ordering and uniqueness
- Temp files prefixed with `.tmp-` are ignored by readers (write-in-progress)

### 3.4 `write-file-atomic` npm package

- Provides cross-platform atomic writes with proper cleanup
- Handles edge cases (permissions, cleanup on crash)
- **Decision:** Use `write-file-atomic` rather than hand-rolling. It handles fsync, temp files, and cleanup correctly.

---

## 4. Required npm Packages

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | latest | Agent runtime (Claude Code SDK) |
| `better-sqlite3` | ^11.0.0 | SQLite database |
| `pino` | ^9.0.0 | Structured logging |
| `pino-pretty` | ^13.0.0 | Dev log formatting |
| `neverthrow` | ^8.0.0 | Result types |
| `zod` | ^3.23.0 | Schema validation |
| `js-yaml` | ^4.1.0 | YAML config parsing |
| `dockerode` | ^4.0.0 | Docker API client |
| `write-file-atomic` | ^6.0.0 | Atomic file writes |
| `cron-parser` | ^5.0.0 | Cron expression parsing |
| `commander` | ^13.0.0 | CLI framework for talonctl |
| `uuid` | ^11.0.0 | UUID generation |
| `ms` | ^2.1.0 | Human-readable time parsing |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.5.0 | TypeScript compiler |
| `vitest` | ^3.0.0 | Test runner |
| `@vitest/coverage-v8` | ^3.0.0 | Coverage provider |
| `eslint` | ^9.0.0 | Linting |
| `@typescript-eslint/eslint-plugin` | ^8.0.0 | TypeScript ESLint rules |
| `@typescript-eslint/parser` | ^8.0.0 | TypeScript ESLint parser |
| `prettier` | ^3.4.0 | Code formatting |
| `eslint-config-prettier` | ^10.0.0 | ESLint+Prettier compat |
| `eslint-plugin-neverthrow` | ^1.0.0 | Enforce Result handling |
| `@types/better-sqlite3` | latest | Type definitions |
| `@types/dockerode` | latest | Type definitions |
| `@types/js-yaml` | latest | Type definitions |
| `@types/write-file-atomic` | latest | Type definitions |

---

## 5. Risks and Unknowns

### R1: Agent SDK Process Model Complexity (HIGH)

The SDK spawns a Claude Code CLI process. Running this inside Docker adds complexity:
- Need to pre-install Claude Code CLI in the container image
- Need to handle process lifecycle (start, monitor, restart)
- stdin/stdout streams must be reliably piped across container boundary
- Session persistence may require mounted volumes

**Mitigation:** Build a proof-of-concept container image early (Phase 1). Validate `spawnClaudeCodeProcess` with Docker. Keep a fallback path where SDK runs on the host with filesystem sandboxing only.

### R2: SDK V2 API Instability (MEDIUM)

V2 session API is marked unstable. If we build on V1 `query()`, we need complex async generator management for multi-turn conversations.

**Mitigation:** Use V1 API. The `streamInput()` method on `Query` allows feeding new messages into an existing conversation without re-creating the generator. This is the multi-turn pattern for V1.

### R3: File-based IPC Reliability Across Docker Bind Mounts (MEDIUM)

`fs.watch()` / inotify may not work reliably across Docker bind mounts on all platforms.

**Mitigation:** Primary polling with `readdir()`. `fs.watch()` as optimization only. 500ms poll interval is acceptable for chat interactions.

### R4: better-sqlite3 Blocking the Event Loop (LOW)

better-sqlite3 is synchronous. Long-running queries could block the event loop.

**Mitigation:** Keep queries simple and indexed. For large result sets, use iterators. Profile query times in integration tests. If needed, offload to worker thread.

### R5: Container Warm Pool Management (MEDIUM)

Managing persistent containers with idle timeouts, eviction, and crash recovery is complex state management.

**Mitigation:** Start simple — one container per active thread, hard timeout, no warm pool optimization. Add eviction/pooling in Phase 2.

### R6: Capability Resolution Correctness (MEDIUM)

The intersection of persona capabilities, skill requirements, and tool labels must be computed correctly and efficiently.

**Mitigation:** Model as pure functions with exhaustive unit tests. Use Zod schemas for capability labels to catch typos at config validation time.

### R7: Hot Reload Without State Loss (MEDIUM)

Reloading config, personas, and channel connectors without losing in-flight work is tricky.

**Mitigation:** New config applies only to new runs. Active containers continue with their original config. Channel connectors implement stop/start lifecycle.

### R8: Claude Code CLI Version Compatibility (LOW)

The Agent SDK depends on the Claude Code CLI being installed. Version mismatches could cause issues.

**Mitigation:** Pin Claude Code CLI version in the container image. Document required version in package.json engines field.

---

## 6. Key Architectural Observations

### 6.1 The SDK Changes Everything

The original design document (AUTONOMOUS_AGENT_DESIGN.md) describes file-based IPC between host and sandbox for tool requests. However, the Agent SDK provides its own IPC mechanism (stdin/stdout streams with the spawned process). This means:

- **Tool execution via SDK hooks** — NOT via file-based IPC. The SDK's `PreToolUse` hook and `canUseTool` callback intercept tool calls before execution. We deny/allow/modify them there.
- **File-based IPC for message delivery** — New inbound messages are delivered to warm containers via file writes that the container's agent polls (or we use `streamInput()` on the Query object to inject new messages).
- **File-based IPC for talonctl** — CLI commands to the daemon.

### 6.2 Two IPC Layers

1. **SDK IPC** (stdin/stdout): Host talond <-> Claude Code CLI process inside container. Automatic, handled by the SDK. Used for all tool calls, responses, and streaming.
2. **File-based IPC** (atomic writes + polling): Used for:
   - Delivering new messages to existing warm sessions (alternative: `streamInput()`)
   - talonctl <-> talond communication
   - Artifact and memory file exchange

### 6.3 Simplified Sandbox Model

Given the SDK handles agent execution, the "sandbox" is really just the Docker container running Claude Code. Our sandbox manager needs to:
1. Create containers with security hardening (read-only rootfs, cap-drop, resource limits)
2. Mount thread-specific directories (memory, artifacts, IPC)
3. Spawn Claude Code CLI inside the container
4. Wire up the SDK's `spawnClaudeCodeProcess` to use `docker exec`
5. Monitor container health and handle crashes
6. Manage idle timeouts and eviction

### 6.4 Single Package (Not Monorepo)

Given the project size and single-team usage, a monorepo adds unnecessary complexity.

**Decision:** Single npm package with a clear internal module structure. Use TypeScript path aliases for clean imports. If plugins need to be distributed separately later, extract to a monorepo then.

---

## 7. Technology Research Summary

| Technology | Verdict | Notes |
|-----------|---------|-------|
| Claude Agent SDK | USE (V1 API) | Core runtime; V2 too unstable |
| better-sqlite3 | USE | Sync API fine for SQLite workload |
| pino | USE | Standard structured logging |
| neverthrow | USE | Constitution mandates Result types |
| zod | USE | Config + IPC message validation |
| dockerode | USE | Typed Docker API |
| write-file-atomic | USE | Reliable atomic writes |
| cron-parser | USE | Proven cron expression library |
| commander | USE | Standard CLI framework |
| js-yaml | USE | YAML parsing |
| vitest | USE | Constitution mandates it |
| kysely | SKIP (v1) | Raw SQL with prepared statements is simpler for v1. Reconsider if query complexity grows. |
| node-cron | SKIP | cron-parser + our own scheduler is cleaner |
| chokidar | SKIP | fs.watch + readdir polling is sufficient |
