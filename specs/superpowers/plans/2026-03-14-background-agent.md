# Background Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `background_agent` host tool that starts Claude Code CLI workers, tracks them in SQLite, and notifies the originating thread on completion without blocking the foreground conversation.

**Architecture:** Resolve persona runtime context in the host-tool layer, pass that prepared context into a background-agent manager, and let the manager own persistence, process lifecycle, and completion notifications. Reuse Talon's existing queue and AgentRunner flow for user-visible completion messages, and extract persona prompt/MCP resolution into a shared helper so background and foreground runs stay aligned.

**Tech Stack:** TypeScript, Node.js `child_process`, better-sqlite3, neverthrow, Zod, pino, vitest

**Spec:** `docs/superpowers/specs/2026-03-14-background-agent-design.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/personas/persona-runtime-context.ts` | Shared persona prompt + external MCP resolution |
| Create | `src/subagents/background/background-agent-types.ts` | Background task domain types |
| Create | `src/core/database/migrations/003-background-tasks.sql` | Background task schema |
| Create | `src/core/database/repositories/background-task-repository.ts` | Background task persistence |
| Create | `src/subagents/background/background-agent-config-builder.ts` | Appended system prompt + temp MCP config |
| Create | `src/subagents/background/background-agent-process.ts` | One-shot Claude CLI process wrapper |
| Create | `src/subagents/background/background-agent-manager.ts` | Task lifecycle orchestration |
| Create | `src/tools/host-tools/background-agent.ts` | Host-tool handler for spawn/status/cancel/result |
| Modify | `src/core/errors/error-types.ts` | Add `BackgroundAgentError` |
| Modify | `src/core/errors/index.ts` | Export `BackgroundAgentError` |
| Modify | `src/core/config/config-schema.ts` | Add `BackgroundAgentConfigSchema` |
| Modify | `src/core/config/config-types.ts` | Export `BackgroundAgentConfig` type |
| Modify | `src/core/database/repositories/index.ts` | Export `BackgroundTaskRepository` |
| Modify | `src/daemon/agent-runner.ts` | Reuse shared persona runtime helper |
| Modify | `src/tools/tool-filter.ts` | Add `subagent.background` mapping |
| Modify | `src/tools/host-tools-bridge.ts` | Register background-agent handler |
| Modify | `src/tools/host-tools-mcp-server.ts` | Expose `background_agent` MCP tool |
| Modify | `src/daemon/daemon-context.ts` | Add repo + manager to runtime context |
| Modify | `src/daemon/daemon-bootstrap.ts` | Wire repository and manager |
| Modify | `src/daemon/daemon.ts` | Shut down active background workers on daemon stop |
| Modify | `config/talond.example.yaml` | Add config section and example capability |
| Test | `tests/unit/core/errors/error-types.test.ts` | Error contract coverage |
| Test | `tests/unit/core/config/config-schema.test.ts` | Config defaults and validation |
| Test | `tests/unit/core/database/repositories/background-task-repository.test.ts` | Repository coverage |
| Test | `tests/unit/personas/persona-runtime-context.test.ts` | Shared runtime helper coverage |
| Test | `tests/unit/subagents/background/background-agent-config-builder.test.ts` | Prompt/config builder coverage |
| Test | `tests/unit/subagents/background/background-agent-process.test.ts` | CLI process wrapper coverage |
| Test | `tests/unit/subagents/background/background-agent-manager.test.ts` | Manager lifecycle coverage |
| Test | `tests/unit/tools/background-agent.test.ts` | Host-tool handler coverage |
| Test | `tests/unit/tools/tool-filter.test.ts` | Capability mapping coverage |
| Test | `tests/unit/tools/host-tools-bridge.test.ts` | Bridge dispatch coverage |
| Test | `tests/unit/daemon/daemon-bootstrap.test.ts` | Bootstrap wiring coverage |
| Test | `tests/unit/daemon/daemon.test.ts` | Shutdown cleanup coverage |

---

## Chunk 1: Foundation

### Task 1: Domain Error and Config Schema

**Files:**
- Modify: `src/core/errors/error-types.ts`
- Modify: `src/core/errors/index.ts`
- Modify: `src/core/config/config-schema.ts`
- Modify: `src/core/config/config-types.ts`
- Test: `tests/unit/core/errors/error-types.test.ts`
- Test: `tests/unit/core/config/config-schema.test.ts`

- [ ] **Step 1: Extend the failing tests**

Add `BackgroundAgentError` assertions to `tests/unit/core/errors/error-types.test.ts`.

Add config assertions to `tests/unit/core/config/config-schema.test.ts`:

```ts
it('parses backgroundAgent defaults', () => {
  const result = TalondConfigSchema.safeParse({});
  expect(result.success).toBe(true);
  expect(result.data.backgroundAgent).toEqual({
    enabled: true,
    maxConcurrent: 3,
    defaultTimeoutMinutes: 30,
    claudePath: 'claude',
  });
});
```

- [ ] **Step 2: Run the tests to see the red state**

Run: `npx vitest run tests/unit/core/errors/error-types.test.ts tests/unit/core/config/config-schema.test.ts`

Expected:
- error-types test fails because `BackgroundAgentError` is missing
- config-schema test fails because `backgroundAgent` is missing

- [ ] **Step 3: Implement the minimal production changes**

Add:

```ts
export class BackgroundAgentError extends TalonError {
  readonly code = 'BACKGROUND_AGENT_ERROR' as const;
}
```

Add:

```ts
export const BackgroundAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  defaultTimeoutMinutes: z.number().int().min(1).max(480).default(30),
  claudePath: z.string().default('claude'),
});
```

Wire `backgroundAgent` into `TalondConfigSchema` and export `BackgroundAgentConfig` from `config-types.ts`.

- [ ] **Step 4: Re-run the tests to green**

Run: `npx vitest run tests/unit/core/errors/error-types.test.ts tests/unit/core/config/config-schema.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/errors/error-types.ts src/core/errors/index.ts src/core/config/config-schema.ts src/core/config/config-types.ts tests/unit/core/errors/error-types.test.ts tests/unit/core/config/config-schema.test.ts
git commit -m "feat(background-agent): add error and config schema"
```

### Task 2: Migration and Repository

**Files:**
- Create: `src/core/database/migrations/003-background-tasks.sql`
- Create: `src/core/database/repositories/background-task-repository.ts`
- Modify: `src/core/database/repositories/index.ts`
- Test: `tests/unit/core/database/repositories/background-task-repository.test.ts`

- [ ] **Step 1: Write the repository test first**

Cover:
- `create`
- `updatePid`
- `updateStatus`
- `findById`
- `findActive`
- `findByThread(threadId, limit?)`
- `countActive`

Use an in-memory SQLite schema that matches the migration.

- [ ] **Step 2: Run the repository test to confirm failure**

Run: `npx vitest run tests/unit/core/database/repositories/background-task-repository.test.ts`

Expected: FAIL because the repository module does not exist

- [ ] **Step 3: Add the migration and repository**

Migration requirements:

```sql
status TEXT NOT NULL DEFAULT 'running'
  CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled'))
created_at INTEGER NOT NULL
started_at INTEGER NOT NULL
completed_at INTEGER
```

Repository requirements:
- extend `BaseRepository`
- use prepared statements
- set `completed_at` only for terminal states
- return recent thread tasks newest-first

- [ ] **Step 4: Re-run the repository test**

Run: `npx vitest run tests/unit/core/database/repositories/background-task-repository.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/database/migrations/003-background-tasks.sql src/core/database/repositories/background-task-repository.ts src/core/database/repositories/index.ts tests/unit/core/database/repositories/background-task-repository.test.ts
git commit -m "feat(background-agent): add background task persistence"
```

---

## Chunk 2: Shared Runtime Context and Spawn Primitives

### Task 3: Shared Persona Runtime Context Helper

**Files:**
- Create: `src/personas/persona-runtime-context.ts`
- Modify: `src/daemon/agent-runner.ts`
- Test: `tests/unit/personas/persona-runtime-context.test.ts`

- [ ] **Step 1: Write the helper test first**

Cover:
- merges skill prompt fragments
- resolves `${ENV_VAR}` placeholders in MCP `env`
- resolves `${ENV_VAR}` placeholders inside header strings
- excludes host-tools when requested
- preserves later skill MCP definitions when names collide

- [ ] **Step 2: Run the helper test to confirm failure**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts`

Expected: FAIL because the helper module does not exist

- [ ] **Step 3: Implement the helper and reuse it from AgentRunner**

Suggested surface:

```ts
export interface PersonaRuntimeContext {
  skillPrompt: string;
  mcpServers: Record<string, unknown>;
}

export function buildPersonaRuntimeContext(args: { ... }): PersonaRuntimeContext
```

Update `src/daemon/agent-runner.ts` to replace the inline skill prompt + MCP resolution block with the helper.

- [ ] **Step 4: Re-run the helper test**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts`

Expected: PASS

- [ ] **Step 5: Run a focused AgentRunner regression check**

Run: `npx vitest run tests/unit/daemon/agent-runner.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/personas/persona-runtime-context.ts src/daemon/agent-runner.ts tests/unit/personas/persona-runtime-context.test.ts
git commit -m "refactor(background-agent): share persona runtime context resolution"
```

### Task 4: Config Builder and Process Wrapper

**Files:**
- Create: `src/subagents/background/background-agent-config-builder.ts`
- Create: `src/subagents/background/background-agent-process.ts`
- Test: `tests/unit/subagents/background/background-agent-config-builder.test.ts`
- Test: `tests/unit/subagents/background/background-agent-process.test.ts`

- [ ] **Step 1: Write the config-builder test first**

Cover:
- prompt contains persona prompt, thread metadata, and autonomous instructions
- temp MCP config file serializes `mcpServers`
- cleanup removes the temp directory

- [ ] **Step 2: Write the process-wrapper test first**

Cover:
- successful command captures stdout
- non-zero exit code is surfaced in the result
- timeout flips `timedOut`
- pid is available immediately after spawn
- listeners are attached before stdin write by using a fast child command

- [ ] **Step 3: Run the tests to confirm failure**

Run: `npx vitest run tests/unit/subagents/background/background-agent-config-builder.test.ts tests/unit/subagents/background/background-agent-process.test.ts`

Expected: FAIL because both modules are missing

- [ ] **Step 4: Implement the minimal spawn primitives**

Config builder:
- build appended system prompt text
- write temp `mcp-config.json`
- do not create a temp `CLAUDE.md`

Process wrapper:
- spawn exactly once
- attach stdout/stderr/close/error listeners inside `start()`
- expose a completion promise instead of a second `run()` entry point
- support `--strict-mcp-config`, `--dangerously-skip-permissions`, and `--no-session-persistence`

- [ ] **Step 5: Re-run the tests**

Run: `npx vitest run tests/unit/subagents/background/background-agent-config-builder.test.ts tests/unit/subagents/background/background-agent-process.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/subagents/background/background-agent-config-builder.ts src/subagents/background/background-agent-process.ts tests/unit/subagents/background/background-agent-config-builder.test.ts tests/unit/subagents/background/background-agent-process.test.ts
git commit -m "feat(background-agent): add prompt builder and cli process wrapper"
```

---

## Chunk 3: Manager and Host Tool

### Task 5: Background Agent Manager

**Files:**
- Create: `src/subagents/background/background-agent-manager.ts`
- Create: `src/subagents/background/background-agent-types.ts`
- Test: `tests/unit/subagents/background/background-agent-manager.test.ts`

- [ ] **Step 1: Write the manager test first**

Cover:
- `spawn` creates a task row and launches a process
- launch failure marks the task failed and returns an error
- concurrency limit rejects new spawns
- completion enqueues a queue notification
- cancel updates status and kills the process
- orphan recovery marks stale running rows failed
- shutdown cancels in-memory workers and cleans temp files

- [ ] **Step 2: Run the manager test to confirm failure**

Run: `npx vitest run tests/unit/subagents/background/background-agent-manager.test.ts`

Expected: FAIL because the manager/types modules are missing

- [ ] **Step 3: Implement the manager**

Key rules:
- manager input contains prepared `systemPrompt` and `mcpServers`
- insert DB row before spawn
- if spawn fails, update the row to `failed`
- when status becomes terminal, truncate stored `output`/`error` to 100 KB
- enqueue completion via `queueManager.enqueue(threadId, 'message', { personaId, content })`

- [ ] **Step 4: Re-run the manager test**

Run: `npx vitest run tests/unit/subagents/background/background-agent-manager.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subagents/background/background-agent-types.ts src/subagents/background/background-agent-manager.ts tests/unit/subagents/background/background-agent-manager.test.ts
git commit -m "feat(background-agent): add background task manager"
```

### Task 6: Host Tool Handler

**Files:**
- Create: `src/tools/host-tools/background-agent.ts`
- Test: `tests/unit/tools/background-agent.test.ts`

- [ ] **Step 1: Write the handler test first**

Cover:
- manifest is `subagent.background`
- `spawn` resolves current persona/thread context and returns task ID
- `status` without `taskId` returns current-thread history
- `status` / `cancel` / `result` reject cross-thread task access
- validation errors for missing fields

- [ ] **Step 2: Run the handler test to confirm failure**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts`

Expected: FAIL because the handler module does not exist

- [ ] **Step 3: Implement the handler**

Resolve:
- persona row from `personaId`
- loaded persona from `PersonaLoader`
- thread row and channel row from `threadId`
- persona runtime context via the shared helper
- optional thread summary via `ContextAssembler`

Build spawn input for the manager with:
- full appended system prompt
- resolved external MCP servers
- `channelId` and human-readable `channelName`

- [ ] **Step 4: Re-run the handler test**

Run: `npx vitest run tests/unit/tools/background-agent.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/host-tools/background-agent.ts tests/unit/tools/background-agent.test.ts
git commit -m "feat(background-agent): add host tool handler"
```

---

## Chunk 4: Integration

### Task 7: Wire Tool Exposure and Bridge Dispatch

**Files:**
- Modify: `src/tools/tool-filter.ts`
- Modify: `src/tools/host-tools-mcp-server.ts`
- Modify: `src/tools/host-tools-bridge.ts`
- Test: `tests/unit/tools/tool-filter.test.ts`
- Test: `tests/unit/tools/host-tools-bridge.test.ts`

- [ ] **Step 1: Extend the failing tests**

Add assertions that:
- `subagent.background` maps to `background_agent`
- `ALL_HOST_TOOLS` length increases by one
- bridge dispatches `background_agent` / `subagent.background` when manager is present

- [ ] **Step 2: Run the focused tests to see the red state**

Run: `npx vitest run tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools-bridge.test.ts`

Expected: FAIL because the new tool mapping/dispatch do not exist yet

- [ ] **Step 3: Implement integration**

Add mapping:

```ts
{ capabilityPrefix: 'subagent.background', internalName: 'subagent.background', mcpName: 'background_agent' }
```

Add a `background_agent` tool entry to `src/tools/host-tools-mcp-server.ts`.

Instantiate `BackgroundAgentHandler` in `HostToolsBridge` using `ctx.backgroundAgentManager` plus the repositories/loaders already available on `DaemonContext`.

- [ ] **Step 4: Re-run the focused tests**

Run: `npx vitest run tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools-bridge.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/tool-filter.ts src/tools/host-tools-mcp-server.ts src/tools/host-tools-bridge.ts tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools-bridge.test.ts
git commit -m "feat(background-agent): expose tool through bridge and mcp server"
```

### Task 8: Wire Bootstrap, Context, Shutdown, and Example Config

**Files:**
- Modify: `src/daemon/daemon-context.ts`
- Modify: `src/daemon/daemon-bootstrap.ts`
- Modify: `src/daemon/daemon.ts`
- Modify: `config/talond.example.yaml`
- Test: `tests/unit/daemon/daemon-bootstrap.test.ts`
- Test: `tests/unit/daemon/daemon.test.ts`

- [ ] **Step 1: Extend the failing tests**

Bootstrap test:
- expects `BackgroundTaskRepository` to be constructed
- expects `backgroundAgentManager` on the returned context

Daemon stop test:
- expects `backgroundAgentManager.shutdown()` before DB close

- [ ] **Step 2: Run the focused tests to see the red state**

Run: `npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/daemon.test.ts`

Expected: FAIL because background-agent wiring is missing

- [ ] **Step 3: Implement the runtime wiring**

Bootstrap order:
1. create repositories, including `backgroundTask`
2. create `QueueManager`
3. create `BackgroundAgentManager`
4. run orphan recovery
5. attach `backgroundAgentManager` to `DaemonContext`

Daemon stop:
- call `ctx.backgroundAgentManager?.shutdown()` before closing the DB

Example config:
- add `backgroundAgent` block
- add `subagent.background` to example persona `capabilities.allow`

- [ ] **Step 4: Re-run the focused tests**

Run: `npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/daemon.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/daemon-context.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon.ts config/talond.example.yaml tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/daemon.test.ts
git commit -m "feat(background-agent): wire daemon bootstrap and shutdown"
```

### Task 9: Final Verification

- [ ] **Step 1: Run the feature-focused test suite**

Run:

```bash
npx vitest run \
  tests/unit/core/errors/error-types.test.ts \
  tests/unit/core/config/config-schema.test.ts \
  tests/unit/core/database/repositories/background-task-repository.test.ts \
  tests/unit/personas/persona-runtime-context.test.ts \
  tests/unit/subagents/background/background-agent-config-builder.test.ts \
  tests/unit/subagents/background/background-agent-process.test.ts \
  tests/unit/subagents/background/background-agent-manager.test.ts \
  tests/unit/tools/background-agent.test.ts \
  tests/unit/tools/tool-filter.test.ts \
  tests/unit/tools/host-tools-bridge.test.ts \
  tests/unit/daemon/daemon-bootstrap.test.ts \
  tests/unit/daemon/daemon.test.ts \
  tests/unit/daemon/agent-runner.test.ts
```

Expected: PASS

- [ ] **Step 2: Run a full type check**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`

Expected: PASS or only pre-existing warnings

- [ ] **Step 4: Commit any verification fixes**

```bash
git add -A
git commit -m "fix(background-agent): address verification issues"
```
