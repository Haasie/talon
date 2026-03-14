# Background Agent: Claude Code CLI Worker

## Problem

Talon's built-in subagents are single-turn helpers. They do not get a Claude Code tool loop, MCP access, or a persistent autonomous session. The main `AgentRunner` does have that capability, but it occupies the thread while it works. Long-running coding, research, or refactoring tasks therefore block normal conversation in the originating thread.

## Goal

Add a new host tool, exposed to the agent as `background_agent` and implemented internally as `subagent.background`, that starts a detached Claude Code CLI worker and returns immediately with a task ID. Talon should track the worker in SQLite, allow the agent to query/cancel it, and send a completion notification back through the thread when the worker exits.

## Non-Goals

- No interactive relay with the background worker after spawn
- No recursive access to Talon's own host-tools MCP server
- No automatic git worktree creation for spawned tasks
- No streaming partial progress beyond polling with `status`
- No attempt to reattach to orphaned Claude processes after daemon restart

## Current-Codebase Constraints

- Talon host tools use dot-notation internally and underscore names in MCP:
  - internal: `subagent.background`
  - MCP: `background_agent`
- Persona context is resolved at runtime from:
  - `PersonaRepository` + `PersonaLoader`
  - `SkillResolver.mergePromptFragments(...)`
  - `SkillResolver.collectMcpServers(...)`
- External MCP servers currently come from persona skills, not directly from capabilities
- Talon stores timestamps in SQLite as Unix epoch milliseconds, not text datetimes
- The installed `claude` CLI supports:
  - `--print`
  - `--output-format json`
  - `--append-system-prompt`
  - `--mcp-config`
  - `--strict-mcp-config`
  - `--dangerously-skip-permissions`

## User-Facing Behavior

### Tool Surface

The agent sees one MCP tool named `background_agent`.

Actions:

| Action | Parameters | Result |
| --- | --- | --- |
| `spawn` | `prompt` required, `workingDirectory` optional, `timeoutMinutes` optional | `{ taskId: string }` |
| `status` | `taskId` optional | one task if `taskId` provided, otherwise recent tasks for the current thread |
| `cancel` | `taskId` required | `{ success: boolean }` |
| `result` | `taskId` required | task result payload |

Capability gate:

- Persona must have `subagent.background` in `allow` or `requireApproval`

Thread scoping:

- `status` without `taskId` returns recent tasks for `context.threadId`
- `status` / `cancel` / `result` with `taskId` must fail if the task belongs to another thread

## Architecture

```text
AgentRunner
  -> host-tools MCP server exposes background_agent
  -> HostToolsBridge dispatches to BackgroundAgentHandler
  -> BackgroundAgentHandler resolves persona runtime context
       - persona prompt fragments
       - external MCP servers from assigned skills
       - current thread/channel context
  -> BackgroundAgentManager persists background_tasks row
  -> BackgroundAgentManager spawns claude CLI wrapper
  -> BackgroundAgentManager watches process exit
  -> completion enqueued as a synthetic queue message
  -> normal AgentRunner flow sends the completion notice to the user
```

## Components

### 1. Persona Runtime Context Helper

Create a small shared helper that builds the runtime context both the main `AgentRunner` and the background-agent path need.

Responsibilities:

- Resolve the loaded persona from `personaId`
- Collect assigned skills from `loadedSkills`
- Merge skill prompt fragments
- Collect external MCP server definitions from persona skills
- Resolve `${ENV_VAR}` placeholders in MCP `env` and HTTP/SSE `headers`
- Exclude Talon's own host-tools MCP server from background workers

Reason:

- This avoids duplicating logic that already exists inline in `AgentRunner`
- It keeps background workers aligned with the same persona/skill model as foreground runs

### 2. Background Task Types

File: `src/subagents/background/background-agent-types.ts`

```ts
export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface BackgroundTask {
  id: string;
  personaId: string;
  threadId: string;
  channelId: string;
  prompt: string;
  workingDirectory: string | null;
  status: BackgroundTaskStatus;
  output: string | null;
  error: string | null;
  pid: number | null;
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  timeoutMinutes: number;
}

export interface BackgroundTaskResult {
  taskId: string;
  status: BackgroundTaskStatus;
  output: string | null;
  error: string | null;
  durationSeconds: number;
}
```

### 3. Background Task Persistence

Migration: `003-background-tasks.sql`

```sql
CREATE TABLE background_tasks (
  id              TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  working_dir     TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled')),
  output          TEXT,
  error           TEXT,
  pid             INTEGER,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  timeout_minutes INTEGER NOT NULL DEFAULT 30
);

CREATE INDEX idx_background_tasks_status ON background_tasks(status);
CREATE INDEX idx_background_tasks_thread_created ON background_tasks(thread_id, created_at DESC);
```

Repository responsibilities:

- create task row
- update PID
- transition status/output/error
- fetch by ID
- fetch active tasks
- fetch recent tasks for a thread
- count active tasks

### 4. Background Agent Config Builder

File: `src/subagents/background/background-agent-config-builder.ts`

Responsibilities:

- Build the appended system prompt string for a background worker
- Write a temporary MCP config JSON file compatible with `claude --mcp-config`
- Clean up temp artifacts after completion

Important correction:

- We do not need a temporary `CLAUDE.md` file
- The current CLI supports `--append-system-prompt`, which is simpler and avoids colliding with project-local `CLAUDE.md`

Prompt contents:

- persona system prompt
- personality content
- merged skill prompt fragments
- thread context summary from `ContextAssembler` when available
- explicit background-task instructions:
  - no human is watching
  - be autonomous
  - produce a concise final summary
- metadata:
  - task ID
  - thread ID
  - channel name

### 5. Background Agent Process Wrapper

File: `src/subagents/background/background-agent-process.ts`

Responsibilities:

- Spawn the child process exactly once
- Attach stdout/stderr/exit listeners before writing stdin
- expose PID immediately after spawn
- kill on timeout or cancellation
- collect bounded stdout/stderr (100 KB max each)

CLI invocation:

```bash
claude --print \
  --output-format json \
  --append-system-prompt "<resolved prompt>" \
  --mcp-config /tmp/.../mcp-config.json \
  --strict-mcp-config \
  --dangerously-skip-permissions \
  --no-session-persistence
```

Notes:

- Prompt is written to stdin
- `cwd` is the task's `workingDirectory`
- `--strict-mcp-config` prevents loading unrelated project/user MCP config
- `--no-session-persistence` keeps workers one-shot and self-contained

### 6. Background Agent Manager

File: `src/subagents/background/background-agent-manager.ts`

Responsibilities:

- enforce configured concurrency using repository state
- create the task row before spawn
- launch the wrapper and persist PID
- update DB on completion / timeout / cancellation
- enqueue synthetic completion notifications through `QueueManager`
- recover orphaned `running` rows on daemon startup
- kill in-memory workers during daemon shutdown

Spawn API:

- input is already-resolved runtime context:
  - `prompt`
  - `workingDirectory`
  - `timeoutMinutes`
  - `systemPrompt`
  - `mcpServers`
  - `personaId`
  - `threadId`
  - `channelId`
  - `channelName`

This keeps persona/skill resolution out of the manager.

Daemon restart recovery:

- Find rows with `status = 'running'`
- If PID missing: mark failed
- If PID dead: mark failed
- If PID alive:
  - on Linux, check `/proc/<pid>/cmdline` for `claude`
  - if not Claude, mark failed as PID reuse
  - if Claude, still mark failed because the daemon cannot reattach
- On platforms without `/proc`, any surviving PID is marked failed with a clear message

### 7. Host Tool Handler

File: `src/tools/host-tools/background-agent.ts`

Responsibilities:

- validate action arguments
- resolve persona + thread + channel context
- build the appended system prompt
- resolve persona-scoped external MCP servers from assigned skills
- call manager methods
- enforce thread ownership on `status`, `cancel`, and `result`

Handler dependencies:

- `BackgroundAgentManager`
- `PersonaRepository`
- `PersonaLoader`
- `ThreadRepository`
- `ChannelRepository`
- `SkillResolver`
- `ContextAssembler`
- `loadedSkills`
- logger

### 8. Completion Notification

When a worker exits, the manager enqueues a normal queue item for the originating thread:

```json
{
  "personaId": "<persona id>",
  "content": "[Background Task Complete] ..."
}
```

This intentionally reuses the existing queue + `AgentRunner` + channel connector flow.

Notification body:

```text
[Background Task Complete] Task <id>: "<prompt preview>"
Status: completed
Output summary: <first 500 chars>
Working directory: <dir or n/a>
Duration: <formatted>
```

Failure / timeout messages use the same format with the actual status and error summary.

### 9. Configuration

Add to root config:

```yaml
backgroundAgent:
  enabled: true
  maxConcurrent: 3
  defaultTimeoutMinutes: 30
  claudePath: "claude"
```

Zod schema:

```ts
export const BackgroundAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  defaultTimeoutMinutes: z.number().int().min(1).max(480).default(30),
  claudePath: z.string().default('claude'),
});
```

## Integration Points

### `tool-filter.ts`

Add mapping:

```ts
{
  capabilityPrefix: 'subagent.background',
  internalName: 'subagent.background',
  mcpName: 'background_agent',
}
```

### `src/tools/host-tools-mcp-server.ts`

Add MCP tool definition for `background_agent`.

### `src/tools/host-tools-bridge.ts`

- instantiate `BackgroundAgentHandler` when `ctx.backgroundAgentManager` exists
- dispatch `subagent.background`

### `src/daemon/daemon-context.ts`

Add:

- `repos.backgroundTask`
- `backgroundAgentManager`

### `src/daemon/daemon-bootstrap.ts`

- construct `BackgroundTaskRepository`
- construct `QueueManager`
- then construct `BackgroundAgentManager`
- run orphan recovery during bootstrap

### `src/daemon/daemon.ts`

Call `backgroundAgentManager.shutdown()` during daemon stop before DB close.

## Security Considerations

- Background workers run with `--dangerously-skip-permissions`; this is acceptable only behind explicit `subagent.background` capability gating
- Workers receive only resolved external MCP servers from persona skills
- Workers do not receive Talon's host-tools MCP server, so they cannot:
  - spawn nested background workers
  - send messages directly
  - manage schedules
  - invoke Talon subagents
- Output and error text stored in SQLite are truncated to bound storage growth

## Open Implementation Choices

- `spawn` startup failure should still leave a failed task record in history; the tool call may return an immediate error message while preserving the record for inspection
- `status` without `taskId` should return a thread-local recent history window, not global active tasks

## Follow-Up Work

- operator CLI for listing/cancelling background tasks
- queued admission when `maxConcurrent` is hit instead of immediate rejection
- richer structured completion summaries
- optional worktree helpers for callers that want isolated coding tasks
