# Talon Daemon Refactor

> Branch: `refactor`
> Started: 2026-03-08

## Way of Working

- **Ivo makes all decisions.** Claude and GPT-5.4 do the coding.
- **Commit often and atomically** — one logical change per commit.
- **This file is the living document** — update it after every significant change so context survives compression.
- **Ivo is building a mental model** — explain the "why" not just the "what". Don't skip steps.
- **GPT-5.4 via OpenCode** handles batch/mechanical refactors across many files. Claude handles analysis, design, and targeted changes.

---

## Findings Summary

### Combined Audit (Claude Opus + GPT-5.4)

**~40% of src/ is dead code** — remnants of a Docker sandbox architecture that was deferred (TASK-037) when the project pivoted to Agent SDK direct execution.

### Dead Code Inventory

| Module | Status | Notes |
|--------|--------|-------|
| `src/sandbox/sandbox-manager.ts` | Dead | `getOrSpawn()` never invoked, containers never created |
| `src/sandbox/sdk-process-spawner.ts` | Dead | `spawn()` never called |
| `src/sandbox/container-factory.ts` | Dead | Docker container creation never triggered |
| `src/sandbox/container-health.ts` | Dead | Health monitor instantiated but unused |
| `src/sandbox/sandbox-types.ts` | Dead | Container state machine never exercised |
| `src/sandbox/session-tracker.ts` | **Keep** | Used by daemon for Agent SDK session resumption |
| `src/ipc/ipc-channel.ts` | Dead | Bidirectional IPC for container communication |
| `src/ipc/ipc-reader.ts` | Dead | File-based IPC reader |
| `src/ipc/ipc-writer.ts` | Dead | File-based IPC writer |
| `src/ipc/daemon-ipc-server.ts` | **Evaluate** | Used for `talonctl` commands (status/reload/shutdown) — may still be needed |
| `src/tools/tool-registry.ts` | Dead | Exported but never instantiated |
| `src/tools/host-tools/schedule-manage.ts` | Dead | Never wired to Agent SDK (BUG-004) |
| `src/tools/host-tools/channel-send.ts` | Dead | Never wired |
| `src/tools/host-tools/memory-access.ts` | Dead | Never wired |
| `src/tools/host-tools/http-proxy.ts` | Dead | Never wired |
| `src/tools/host-tools/db-query.ts` | Dead | Never wired (but has good SQL injection protection) |
| `src/collaboration/supervisor.ts` | Dead | Never imported anywhere |
| `src/collaboration/worker-manager.ts` | Dead | Never imported anywhere |
| `src/mcp/mcp-proxy.ts` | Dead | `handleToolCall()` never called — MCP servers bypass proxy, go directly to Agent SDK |
| `src/mcp/mcp-registry.ts` | Dead | Started in daemon but the registered servers are never queried |

### Bugs Found During Audit

| ID | Description |
|----|-------------|
| BUG-004 | `schedule.manage` host tool is dead code — agent can't create schedules. Needs MCP exposure. |
| BUG-005 | `schedule.manage` create action sets `next_run_at: null` — schedules never fire. |
| — | `SessionTracker` never evicts old entries — memory leak for long-running daemon. |
| — | Lines 244-247: `MemoryRepository`, `ArtifactRepository`, `ToolResultRepository` instantiated but never stored or used. |

### The Core Problem: `daemon.ts` (1373 lines)

`TalondDaemon` is a god object doing everything:

1. **Bootstrap** (lines 177-446): Config loading, DB setup, migrations, 12 repository instantiations, persona/skill loading, MCP registration, sandbox/container factory init, crash recovery, channel wiring, queue/scheduler init, PID file, IPC server, watchdog.

2. **Lifecycle** (lines 466-562): Graceful shutdown in reverse order, 20+ null field resets.

3. **Health** (lines 574-593): Point-in-time snapshot.

4. **Hot reload** (lines 620-808): Re-read config, diff channels/personas, reload skills — with **duplicated** skill directory resolution logic (identical to bootstrap).

5. **IPC command dispatch** (lines 958-1045): status/reload/shutdown handlers.

6. **Channel wiring** (lines 810-940): Connector creation, DB seeding, binding setup, message handler registration, MCP re-registration — with **duplicated** MCP registration logic.

7. **Queue item handling** (lines 1047-1333): The 287-line `handleQueueItem` — persona lookup, run creation, workspace setup, prompt assembly, session recovery, MCP env var substitution, Agent SDK options, typing indicators, streaming response parsing, session persistence, channel delivery, message recording, run status.

8. **Connector factory** (lines 1353-1373): Hardcoded switch statement for channel types.

**20+ nullable fields** (lines 101-138) require defensive null checks everywhere. The 12-field null guard at line 1061-1074 is the worst symptom.

---

## Proposed Architecture

Split `daemon.ts` into 5 focused modules:

```
src/daemon/
├── daemon.ts                  (~150 lines) Thin lifecycle orchestrator
├── daemon-bootstrap.ts        (~200 lines) Startup sequence → produces DaemonContext
├── daemon-context.ts          (~50 lines)  Immutable shared state container
├── agent-runner.ts            (~200 lines) Agent SDK execution per queue item
├── channel-factory.ts         (~50 lines)  Self-registering connector factory
└── skill-resolver-service.ts  (~100 lines) Skill + MCP resolution (deduplicates)
```

### 1. `DaemonContext` — Kill the nullables

```typescript
/** Populated once during bootstrap, immutable after. Passed by reference to all subsystems. */
interface DaemonContext {
  readonly db: Database.Database;
  readonly config: TalondConfig;
  readonly repos: {
    readonly queue: QueueRepository;
    readonly thread: ThreadRepository;
    readonly channel: ChannelRepository;
    readonly persona: PersonaRepository;
    readonly schedule: ScheduleRepository;
    readonly message: MessageRepository;
    readonly run: RunRepository;
    readonly binding: BindingRepository;
    readonly audit: AuditRepository;
  };
  readonly channelRegistry: ChannelRegistry;
  readonly queueManager: QueueManager;
  readonly scheduler: Scheduler;
  readonly personaLoader: PersonaLoader;
  readonly sessionTracker: SessionTracker;
  readonly threadWorkspace: ThreadWorkspace;
  readonly auditLogger: AuditLogger;
  readonly skillService: SkillResolverService;
  readonly logger: pino.Logger;
}
```

No more null checks. `start()` builds a `DaemonContext` or fails entirely.

### 2. `DaemonBootstrap` — Extract the 250-line `start()` sequence

```typescript
class DaemonBootstrap {
  static async bootstrap(configPath: string, logger: pino.Logger): Promise<Result<DaemonContext, DaemonError>>
}
```

### 3. `AgentRunner` — Extract the 287-line `handleQueueItem`

```typescript
class AgentRunner {
  constructor(private readonly ctx: DaemonContext) {}
  async run(item: QueueItem): Promise<Result<void, Error>>
}
```

### 4. `ChannelFactory` — Replace the hardcoded switch

```typescript
// Each connector registers itself
registerChannelType('telegram', (config, name, logger) => new TelegramConnector(...));
```

### 5. `SkillResolverService` — Deduplicate skill/MCP logic

Used by both bootstrap and reload. Handles skill directory discovery, loading, MCP env var substitution, prompt fragment merging.

### What to remove (dead code)

| Module | Action |
|--------|--------|
| `src/sandbox/*` (except `session-tracker.ts`) | Remove — dead Docker path |
| `src/ipc/ipc-channel.ts`, `ipc-reader.ts`, `ipc-writer.ts` | Remove — container IPC |
| `src/ipc/daemon-ipc-server.ts` | Keep for now — `talonctl` uses it |
| `src/tools/tool-registry.ts` | Remove |
| `src/tools/host-tools/*` | Don't remove — wire as MCP servers instead |
| `src/collaboration/*` | Remove |
| `src/mcp/mcp-proxy.ts` | Remove |
| `src/mcp/mcp-registry.ts` | Evaluate — may be useful if host-tools become MCP |

### Key insight: host-tools should become MCP servers

The 5 host tools (`schedule.manage`, `channel.send`, `memory.access`, `http.proxy`, `db.query`) were designed for the IPC architecture. They're fully implemented but never wired. Instead of deleting them, they should be exposed as MCP servers that the Agent SDK can call. This:
- Fixes BUG-004 (schedule.manage unreachable)
- Works identically in both host and future Docker modes
- Leverages existing implementation

---

## Execution Plan

| Step | Description | Status |
|------|-------------|--------|
| 1 | Create `DaemonContext` interface | Done (`daemon-context.ts`) |
| 2 | Extract `DaemonBootstrap` | Done (`daemon-bootstrap.ts`) |
| 3 | Extract `AgentRunner` | Done (`agent-runner.ts`) |
| 4 | Extract `SkillResolverService` (dedup) | Done (moved to `SkillLoader.loadFromPersonaConfig()`) |
| 5 | Extract `ChannelFactory` | Done (`channel-factory.ts`) |
| 6 | Remove confirmed dead code | Done |
| 7 | Wire host-tools as MCP servers | Done |
| 8 | Fix BUG-005 (next_run_at null) + scheduler payload mismatch | Done |
| 9 | Add SessionTracker eviction | Done |
| 10 | Slim down daemon.ts to thin orchestrator | Not started |

Each step = one atomic commit. Steps 1-5 are pure refactors (no behavior change). Steps 6-9 are fixes/cleanup. Step 10 is the final assembly.

---

## Testing Strategy

### Current State

- **92 test files** — 88 unit, 4 integration
- **BUG-001**: 359 pre-existing test failures (noted in BOARD.md)
- Tests are slow — **do not run tests without asking Ivo first**

### Tests for Dead Code (will be removed with code)

These test files correspond to dead code. They should be removed alongside their source modules:

| Test file | Tests for |
|-----------|-----------|
| `unit/sandbox/container-factory.test.ts` | Dead: Docker container creation |
| `unit/sandbox/sandbox-manager.test.ts` | Dead: container lifecycle |
| `unit/sandbox/sdk-process-spawner.test.ts` | Dead: SDK process in Docker |
| `unit/ipc/ipc-channel.test.ts` | Dead: bidirectional container IPC |
| `unit/ipc/ipc-reader.test.ts` | Dead: file-based IPC reader |
| `unit/ipc/ipc-writer.test.ts` | Dead: file-based IPC writer |
| `unit/collaboration/supervisor.test.ts` | Dead: never imported |
| `unit/collaboration/worker-manager.test.ts` | Dead: never imported |
| `unit/mcp/mcp-proxy.test.ts` | Dead: MCP proxy bypassed |
| `unit/tools/tool-registry.test.ts` | Dead: never instantiated |

### Tests to Keep and Update

These test files cover code being refactored (not deleted). They need updating to match the new module structure:

| Test file | Update needed |
|-----------|---------------|
| `unit/daemon/daemon.test.ts` | Major rewrite — split to match new modules |
| `unit/daemon/reload.test.ts` | Update for `SkillResolverService` dedup |
| `unit/sandbox/session-tracker.test.ts` | Keep as-is (module survives refactor) |
| `unit/tools/host-tools/*.test.ts` (5 files) | Keep — add MCP server wrapper tests |
| `unit/mcp/mcp-registry.test.ts` | Evaluate — depends on whether we keep it |

### New Tests Needed

#### Unit tests for new modules

| Module | Tests to write |
|--------|---------------|
| `daemon-context.ts` | Type-level only (interface), no runtime tests needed |
| `daemon-bootstrap.ts` | Test bootstrap produces valid `DaemonContext` or fails cleanly |
| `agent-runner.ts` | Test persona resolution, prompt assembly, session management, error handling |
| `channel-factory.ts` | Test registration and creation of connectors |
| `skill-resolver-service.ts` | Test skill loading, MCP env var substitution, prompt merging |

#### Integration tests (the important part)

These verify the pieces actually wire together — specifically to prevent dead code from creeping back in:

| Test | What it proves |
|------|---------------|
| Bootstrap → AgentRunner wiring | Queue items actually reach the agent runner |
| Bootstrap → Scheduler → Queue | Scheduled tasks fire and reach the queue |
| MCP servers reachable by agent | Host-tool MCP servers are callable (once wired) |
| Channel → Pipeline → Queue → Runner → Channel | Full message round-trip without Docker/IPC |
| Reload preserves sessions | Hot reload doesn't drop active `SessionTracker` state |
| Channel factory completeness | Every channel type in config schema has a registered factory |

### Test execution note

Tests are slow. Ivo runs them manually. When proposing changes, describe what to test and which test files are affected rather than running them.

---

## Progress Log

_Updated after each commit._

### 2026-03-08

- **Step 1**: Created `DaemonContext` interface (`daemon-context.ts`) — immutable runtime state, all fields non-null, `DaemonRepos` bundle.
- **Step 2**: Extracted `DaemonBootstrap` (`daemon-bootstrap.ts`) — pure setup phase returning `Result<DaemonContext, DaemonError>`.
- **Step 4**: Deduplicated skill loading — moved to `SkillLoader.loadFromPersonaConfig()` instead of separate `SkillResolverService`.
- **Step 5**: Extracted `ChannelFactory` (`channel-factory.ts`) — `createConnector()` switch from daemon.ts bottom.
- **Cleanup**: Moved `registerChannels` to `src/channels/channel-setup.ts` (shared by bootstrap and reload).
- **Cleanup**: Moved `RepositoryAuditStore` from `daemon-bootstrap.ts` to `audit-repository.ts` (keep classes with their domain).
- **Step 3**: Extracted `AgentRunner` (`agent-runner.ts`) — 287-line `handleQueueItem` → standalone class taking `DaemonContext`. Eliminated 12-field null guard, removed dead `sandboxManager`/`sdkProcessSpawner` refs.
- **Step 6**: Removed dead code — 14 source files, 10 test files. Deleted: `src/collaboration/` (entire), sandbox Docker scaffolding (5 files), container IPC (3 files), `mcp-proxy`, `tool-registry`, `approval-gate`, `capability-resolver`, `policy-engine`. Updated barrel files. Kept: `session-tracker`, `daemon-ipc-*`, `mcp-registry`, `host-tools/`, `tool-types`.
- **Step 7**: Wired host-tools as MCP servers via Unix socket bridge. Created `host-tools-bridge.ts` (daemon-side socket server dispatching to handlers), `host-tools-mcp-server.ts` (standalone stdio MCP server for Agent SDK). Added `MemoryRepository` to `DaemonRepos`, `HostToolsBridge` to `DaemonContext`. AgentRunner injects host-tools MCP server into every `query()` call with context env vars. Fixes BUG-004 (schedule.manage now reachable).
- **Cleanup**: Removed remaining dead refs from daemon.ts (SandboxManager, ContainerFactory, SdkProcessSpawner, McpProxy). Replaced duplicate `createConnector` with import from `channel-factory.ts`. Deleted `tests/integration/ipc.test.ts`. Rewrote `host-tools-bridge.test.ts`. Added tests for AgentRunner, DaemonBootstrap, ChannelFactory.
- **Step 8**: Fixed BUG-005 — `schedule.manage` create now computes `next_run_at` via `getNextCronTime()`. Update also recomputes `next_run_at` when cron expression changes. Fixed scheduler payload mismatch — `processSchedule()` now injects `personaId` from schedule row and maps `prompt` → `content` for AgentRunner compatibility.
- **Step 9**: Added TTL-based eviction to `SessionTracker`. Entries track `lastUsedAt`, expire after configurable TTL (default 24h). Lazy eviction on `get`/`has`, bulk eviction via `evictStale()`. Fixes unbounded memory growth in long-running daemon.
