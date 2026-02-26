# agentd — Autonomous Agent Daemon v1

## Functional Specification

> Source: `AUTONOMOUS_AGENT_DESIGN.md`
> Status: DRAFT — awaiting human approval
> Date: 2026-02-26

---

## 1. Overview

agentd is a long-running TypeScript daemon that orchestrates autonomous AI agents across multiple communication channels. Each agent runs inside an isolated container sandbox and communicates with the host through file-based IPC. The host enforces all security policy, mediates side effects, and manages persistence.

### 1.1 Core Capabilities

- Multi-channel messaging (WhatsApp, Telegram, Slack, email, Discord)
- Persona-per-channel agent profiles with configurable tools and policies
- Container-sandboxed agent execution (Docker, rootless, Apple Container)
- Per-thread persistent memory (transcript, working memory, notebook, structured facts)
- Durable work queue with crash recovery and idempotent processing
- Scheduled tasks (cron, interval, one-shot, event-triggered)
- Multi-agent collaboration via Agent SDK subagents
- MCP tool integration (host-brokered)
- CLI management via `agentctl`

### 1.2 Design Principles

- **Resilient by default**: durable queues, crash recovery, idempotent processing, bounded concurrency, backpressure
- **Secure by construction**: OS isolation, capability-based tool execution, explicit mount policy, secrets never copied into sandboxes by default
- **Small core + plugins**: channels, skills, tool providers, and storage backends are all plugins
- **Host is the policy enforcement point**: sandboxes request actions; the host decides

---

## 2. System Components

### 2.1 agentd (Host Daemon)

The central process. Single-threaded Node.js event loop, all I/O async/non-blocking.

**Responsibilities:**
- Channel connector lifecycle (start/stop/health)
- Message normalization and deduplication
- Thread routing (channel+thread -> persona via bindings)
- Durable work queue management
- Sandbox lifecycle (spawn, warm idle, timeout, graceful shutdown)
- Policy enforcement (capability checks, approval gates)
- IPC multiplexing (host <-> sandbox communication)
- Scheduler (cron/interval/one-shot tick processing)
- Audit logging (append-only, every side-effecting operation)
- Metrics collection
- Configuration loading and hot reload

**Acceptance Criteria:**
- AC-2.1.1: agentd starts, loads config from `agentd.yaml`, and enters ready state within 5 seconds
- AC-2.1.2: agentd handles SIGTERM gracefully — drains queue, signals containers, waits grace period (10s), exits
- AC-2.1.3: agentd recovers from crash — replays durable queue, cleans stale sandboxes on restart
- AC-2.1.4: agentd hot-reloads config, personas, skills, and channel connectors on `agentctl reload` without restarting

### 2.2 Warm Containers (Sandbox Runtime)

Persistent containers per thread running the Anthropic Claude Agent SDK.

**Responsibilities:**
- Execute agent runs using `@anthropic-ai/claude-agent-sdk`
- Maintain SDK session state for context continuity across messages
- Poll IPC input directory for new messages
- Emit tool requests, outbound messages, and artifacts via IPC output
- Self-contained skill and MCP client loading

**Lifecycle:**
1. **Spawn**: First message to a thread triggers creation. Config (secrets, persona, session ID) delivered via stdin JSON.
2. **Warm idle**: After completing a run, stays alive polling `ipc/input/`. SDK session preserved.
3. **Follow-up**: New messages delivered via IPC file write. Container resumes SDK session.
4. **Timeout**: Configurable idle timeout (default 30 min). Hard timeout reaps container.
5. **Graceful shutdown**: Shutdown signal via IPC. 10-second grace period before forced kill.

**Acceptance Criteria:**
- AC-2.2.1: Container spawns within 3 seconds of first message to a new thread
- AC-2.2.2: Container stays warm and responds to follow-up messages without re-spawning
- AC-2.2.3: Container is reaped after idle timeout with no data loss
- AC-2.2.4: If container dies unexpectedly, next message spawns fresh container with context reconstructed from DB transcript + memory files
- AC-2.2.5: Container has no host access except explicitly granted mounts

### 2.3 agentctl (CLI)

CLI tool for operating agentd. Communicates with the daemon via file-based IPC.

**Commands:**
| Command | Description |
|---------|-------------|
| `agentctl status` | Health check, active containers, queue depth |
| `agentctl setup` | Interactive first-time setup |
| `agentctl doctor` | Re-run checks, show actionable fixes |
| `agentctl add-channel <type>` | Add connector config, validate credentials |
| `agentctl add-persona <name>` | Scaffold persona prompt + default policy |
| `agentctl add-skill <skill>` | Install/enable a skill |
| `agentctl migrate` | Apply DB migrations safely |
| `agentctl backup` | Snapshot SQLite + data directory |
| `agentctl reload` | Hot-reload config without restart |

**Acceptance Criteria:**
- AC-2.3.1: `agentctl status` returns JSON-serializable health info within 2 seconds
- AC-2.3.2: `agentctl` commands work when agentd is running; return clear errors when agentd is stopped
- AC-2.3.3: File-based IPC: command files written to input dir; processed files deleted; failed files moved to errors dir

---

## 3. Data Model

### 3.1 Database

SQLite via `better-sqlite3`. Abstract persistence interface (repository pattern) for future Postgres swap.

### 3.2 Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `channels` | Channel configs + credential refs | `id`, `type`, `name`, `config`, `credentials_ref`, `enabled` |
| `personas` | Agent profiles | `id`, `name`, `model`, `system_prompt_file`, `skills`, `capabilities`, `mounts` |
| `bindings` | Channel/thread -> persona routing | `id`, `channel_id`, `thread_id`, `persona_id`, `is_default` |
| `threads` | Canonical thread metadata | `id`, `channel_id`, `external_id`, `metadata`, `created_at` |
| `messages` | Normalized inbound/outbound messages | `id`, `thread_id`, `direction`, `content`, `idempotency_key`, `provider_id`, `created_at` |
| `queue_items` | Durable work queue | `id`, `thread_id`, `message_id`, `status`, `attempts`, `max_attempts`, `next_retry_at`, `error` |
| `runs` | Agent execution records | `id`, `thread_id`, `persona_id`, `sandbox_id`, `status`, `parent_run_id`, `started_at`, `ended_at` |
| `schedules` | Cron/interval/one-shot jobs | `id`, `persona_id`, `thread_id`, `type`, `expression`, `payload`, `enabled`, `next_run_at` |
| `memory_items` | Structured memory (facts, summaries) | `id`, `thread_id`, `type`, `content`, `embedding_ref`, `created_at` |
| `artifacts` | Agent output files | `id`, `run_id`, `thread_id`, `path`, `mime_type`, `size`, `created_at` |
| `audit_log` | Append-only audit trail | `id`, `run_id`, `thread_id`, `persona_id`, `action`, `tool`, `request_id`, `details`, `created_at` |
| `tool_results` | Idempotent tool result cache | `run_id`, `request_id`, `result`, `created_at` |

**Acceptance Criteria:**
- AC-3.2.1: All tables created via versioned migrations (`agentctl migrate`)
- AC-3.2.2: Foreign key constraints enforced (SQLite `PRAGMA foreign_keys = ON`)
- AC-3.2.3: `idempotency_key` on messages is unique per channel — duplicate inserts are no-ops
- AC-3.2.4: `tool_results` keyed by `(run_id, request_id)` — safe to retry tool calls

### 3.3 Filesystem Layout

```
data/
  agentd.sqlite
  threads/
    <thread_id>/
      memory/          # human-editable (CLAUDE.md, TASKS.md, etc.)
      attachments/     # ingested inbound files
      artifacts/       # agent output files
      ipc/
        input/         # host -> container messages
        output/        # container -> host messages
        errors/        # failed IPC messages
```

**Acceptance Criteria:**
- AC-3.3.1: Thread directories created on first message to a thread
- AC-3.3.2: Host code owns all directories; sandbox only sees what is mounted
- AC-3.3.3: Default mounts: `memory/` as RO, `artifacts/` as RW

---

## 4. Event Flow

### 4.1 Message -> Reply (Happy Path)

1. Channel connector receives inbound event
2. Normalize into canonical `Message` (with stable `idempotency_key`)
3. Persist to `messages` table + deduplicate (skip if key exists)
4. Resolve `thread_id` and route to persona via `bindings`
5. Enqueue `queue_item` for that thread (FIFO)
6. Thread queue runner dequeues when allowed (concurrency limits)
7. Route to thread's warm container (or spawn one if none exists)
8. Deliver message via IPC (atomic file write to `ipc/input/`)
9. Container executes agent using Agent SDK (with session resumption)
10. Agent requests tool actions via IPC; host validates against policy, executes, returns results
11. Container emits outbound message(s) via IPC; host persists and sends through channel
12. Run finalizes; host updates thread memory according to policy
13. Container remains warm, polling for follow-up messages

**Acceptance Criteria:**
- AC-4.1.1: End-to-end message -> reply completes within reasonable time (LLM latency dominates)
- AC-4.1.2: Duplicate inbound messages (same idempotency key) do not trigger duplicate runs
- AC-4.1.3: Messages within a thread are processed FIFO — no interleaved runs
- AC-4.1.4: If container is busy, new messages queue and process in order

### 4.2 Error Handling

- **Transient failures** (network, rate limits): exponential backoff with jitter, capped attempts
- **Container crash**: mark run as failed, requeue message, spawn fresh container on next attempt
- **Dead letter**: after max attempts, move to dead-letter state with human-readable reason
- **Outbound send failure**: retry with channel-specific backoff; log after max retries

**Acceptance Criteria:**
- AC-4.2.1: Failed queue items retry with exponential backoff (base 1s, max 60s, jitter)
- AC-4.2.2: After max attempts (default 3), item moves to dead-letter status with reason
- AC-4.2.3: Dead-letter items are visible via `agentctl status`

---

## 5. IPC System

### 5.1 Transport

File-based atomic writes with polling. Each thread's IPC lives under `data/threads/<thread_id>/ipc/`.

**Protocol:**
- Write: create temp file -> atomic rename into target directory
- Read: poll directory for new files (configurable interval, default 500ms)
- Success: processing complete -> delete file
- Failure: move file to `errors/` subdirectory

### 5.2 Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `message.new` | host -> container | New inbound message for processing |
| `message.send` | container -> host | Outbound message to send via channel |
| `tool.request` | container -> host | Tool execution request |
| `tool.result` | host -> container | Tool execution result |
| `memory.read` | container -> host | Read memory item |
| `memory.write` | container -> host | Write memory item |
| `artifact.put` | container -> host | Store output file |
| `shutdown` | host -> container | Graceful shutdown signal |

### 5.3 Message Format

```typescript
interface IpcMessage {
  id: string;            // unique message ID (UUID)
  type: string;          // message type from table above
  runId: string;         // current run ID
  threadId: string;      // thread context
  payload: unknown;      // type-specific payload
  timestamp: number;     // Unix epoch ms
}
```

**Acceptance Criteria:**
- AC-5.3.1: IPC messages are valid JSON with all required fields
- AC-5.3.2: Atomic rename prevents partial reads
- AC-5.3.3: Unprocessable messages are moved to `errors/` (not silently dropped)
- AC-5.3.4: IPC works across Docker bind mounts

---

## 6. Channel System

### 6.1 Channel Connector Interface

```typescript
interface ChannelConnector {
  readonly type: string;
  readonly name: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  // Emits normalized inbound events
  onMessage(handler: (msg: InboundEvent) => void): void;

  // Delivers outbound messages
  send(threadId: string, output: AgentOutput): Promise<void>;

  // Converts markdown to channel-native format
  format(markdown: string): string;
}

interface AgentOutput {
  body: string;                   // markdown
  attachments?: Attachment[];     // files, images
  actions?: Action[];             // buttons, approval prompts
}
```

### 6.2 Supported Channels (v1)

| Channel | Idempotency Key Source | Format Target |
|---------|----------------------|---------------|
| Telegram | `update_id` | MarkdownV2 or HTML |
| WhatsApp | `message_id` | WhatsApp-flavored markdown |
| Slack | `event_id` | mrkdwn |
| Email | `Message-ID` header | HTML (via markdown-to-HTML) |
| Discord | `message_id` | Discord-flavored markdown |

### 6.3 Connector Responsibilities

- Provide stable idempotency keys for inbound events
- Ingest attachments into thread `attachments/` directory
- Rate limiting + retries with provider-specific backoff
- Retry outbound sends on transient failures

**Acceptance Criteria:**
- AC-6.3.1: Each channel connector implements the `ChannelConnector` interface
- AC-6.3.2: Inbound messages are normalized with provider-specific idempotency keys
- AC-6.3.3: Outbound markdown is correctly converted to channel-native format
- AC-6.3.4: Channels that don't support attachments/actions silently drop them (with audit log)
- AC-6.3.5: Connectors can be hot-reloaded without daemon restart

---

## 7. Routing

### 7.1 Binding Model

Routing is explicit via the `bindings` table:
- `(channel_id, thread_id)` -> `persona_id`
- Default persona per channel if no specific binding exists
- In-channel commands (`/bind personaX`) change bindings (subject to auth)

**Acceptance Criteria:**
- AC-7.1.1: Messages route to the bound persona for that channel+thread
- AC-7.1.2: If no binding exists, use the channel's default persona
- AC-7.1.3: If no default persona exists, drop message with audit log entry

---

## 8. Persona System

### 8.1 Persona Configuration

```yaml
personas:
  - name: alfred
    model: claude-sonnet-4-6
    systemPromptFile: personas/alfred/system.md
    skills: [gmail, web]
    capabilities:
      allow:
        - channel.send:telegram
        - net.http:egress
        - fs.read:workspace
      requireApproval:
        - fs.write:workspace
    mounts:
      - source: data/threads/{thread}/memory
        target: /workspace/memory
        mode: ro
      - source: data/threads/{thread}/artifacts
        target: /workspace/artifacts
        mode: rw
```

### 8.2 Capability Labels

Tools are gated by capability labels, not raw tool names:
- `fs.read:workspace`, `fs.write:artifacts`
- `net.http:egress`
- `channel.send:<channel_type>`
- `secrets.use:<secret_name>`

Personas allow capabilities. Skills request capabilities. Host resolves the intersection.

**Acceptance Criteria:**
- AC-8.2.1: A tool call is rejected if the persona does not allow the required capability
- AC-8.2.2: `requireApproval` capabilities trigger an in-channel approval prompt before execution
- AC-8.2.3: Capability resolution: `persona.allow ∩ skill.required` = granted capabilities

---

## 9. Tool System

### 9.1 Tool Types

| Type | Execution Location | Examples |
|------|-------------------|----------|
| Host tools | In agentd process | DB queries, scheduling, channel send, secrets-aware HTTP |
| Sandbox tools | Inside container | Safe shell (workspace-scoped), file read/write |
| MCP tools | Via MCP servers (host-brokered) | Third-party integrations |

### 9.2 Tool Execution Flow

1. Container emits `tool.request` via IPC
2. Host receives request, validates:
   - Tool exists and is enabled for this persona
   - Required capabilities are allowed
   - Arguments pass schema validation
   - Rate limits not exceeded
3. If `requireApproval`: send approval prompt to user via channel; block until response
4. Execute tool (host-side or forward to MCP server)
5. Store result in `tool_results` table (keyed by `run_id + request_id`)
6. Return `tool.result` via IPC
7. Audit log entry for every tool execution

**Acceptance Criteria:**
- AC-9.2.1: Tool calls without required capabilities are rejected with clear error
- AC-9.2.2: Tool calls are idempotent — same `(run_id, request_id)` returns cached result
- AC-9.2.3: Tool execution timeout (configurable, default 30s) prevents hanging
- AC-9.2.4: Every tool call is audit-logged with `run_id`, `tool`, `request_id`, and result status

---

## 10. Security Model

### 10.1 Sandbox Hardening

Docker defaults:
- Rootless containers when possible
- `--cap-drop=ALL`
- `--read-only` rootfs with tmpfs for `/tmp`
- No Docker socket
- Strict seccomp + AppArmor/SELinux if available
- Resource limits: CPU, memory, PIDs, disk quota
- Network default: **off**
- Mount allowlist: only thread-scoped directories unless explicitly configured

### 10.2 Secrets Management

- Secrets live on the host (env/OS keychain/secret store)
- Not mounted into sandboxes by default
- Delivered via stdin JSON at container spawn time
- Container bash hooks strip sensitive env vars before subprocess execution
- If a tool requires a secret, the host executes that tool (or passes short-lived tokens)

### 10.3 Approval Gates

High-risk capabilities require one of:
- Interactive user approval (in-channel "Approve? y/n")
- Pre-approved policy with explicit domain/path allowlists
- Schedule-only mode with predeclared outputs

**Acceptance Criteria:**
- AC-10.1.1: Containers start with no host access except explicitly granted mounts
- AC-10.1.2: Containers cannot access the Docker socket
- AC-10.1.3: Network is disabled by default; enabled only per persona/tool policy
- AC-10.2.1: Secrets are never written to disk inside containers
- AC-10.2.2: Secrets are passed via stdin JSON at spawn, not via env vars or mounted files
- AC-10.3.1: `requireApproval` tools block until user responds; timeout after configurable period

---

## 11. Memory System

### 11.1 Memory Layers

| Layer | Storage | Purpose |
|-------|---------|---------|
| Transcript | DB `messages` table | Canonical message log, never rewritten |
| Working memory | In-prompt context | Recent window included in agent prompts |
| Thread notebook | Files (`memory/CLAUDE.md`, etc.) | Human-editable per-thread notes |
| Structured memory | DB `memory_items` table | Extracted facts + summaries |
| Vector memory | Optional embeddings store | Retrieval over attachments + notes |

### 11.2 Memory Policies

- Only write to `artifacts/` or `memory/` if persona has the capability
- Enforce redaction rules (never store raw secrets)
- Encryption at rest optional (SQLCipher or OS-level)

**Acceptance Criteria:**
- AC-11.2.1: Memory writes are gated by persona capabilities
- AC-11.2.2: Thread notebook files persist across container restarts
- AC-11.2.3: Context reconstruction from DB transcript + memory files works when a container is replaced

---

## 12. Multi-Agent Collaboration

### 12.1 Model

- A **Supervisor persona** owns the run and spawns **Worker personas** via the SDK's `Task` tool
- Workers communicate only via host-mediated messages
- Supervisor determines task dependencies dynamically (no predefined task graph)

### 12.2 Implementation

- `runs` table supports `parent_run_id` for child runs (subagent invocations)
- Each worker gets its own sandbox, tool scope, and memory scope
- Worker outputs stored as artifacts; supervisor reads artifacts + summaries
- Retry policy: configurable per persona, default 3 retries per worker task

### 12.3 Safety

- Workers never get direct channel send unless explicitly allowed
- Supervisor must explicitly request user-facing message sends

**Acceptance Criteria:**
- AC-12.2.1: Child runs are tracked via `parent_run_id` and visible in audit
- AC-12.2.2: Worker sandbox isolation is the same as any other sandbox (no privilege escalation)
- AC-12.3.1: Workers cannot send channel messages unless their persona explicitly allows it

---

## 13. Scheduling

### 13.1 Schedule Types

| Type | Example | Behavior |
|------|---------|----------|
| Cron | `0 9 * * *` | Recurring at cron expression |
| Interval | `every 30m` | Recurring at fixed interval |
| One-shot | `at 2026-03-01T10:00Z` | Single execution at specified time |
| Event-triggered | `after:channel.message` | Fires after a specific event |

### 13.2 Scheduler Behavior

- Wakes every tick (configurable, 1s-10s)
- Claims due jobs with DB locking (prevents double-execution)
- Enqueues work through the same thread/persona routing + policy system
- Jobs execute as normal runs

**Acceptance Criteria:**
- AC-13.2.1: Cron schedules fire within one tick of their due time
- AC-13.2.2: Concurrent scheduler instances (after crash restart) do not double-execute jobs
- AC-13.2.3: Disabled schedules (`enabled: false`) are skipped

---

## 14. Configuration

### 14.1 Config File

Single `agentd.yaml` with sane defaults. See design doc for full example.

**Key sections:**
- `storage`: SQLite path (or Postgres URL)
- `sandbox`: runtime, image, maxConcurrent, networkDefault
- `channels`: list of channel connector configs
- `personas`: list of persona definitions
- `schedules`: list of scheduled jobs

### 14.2 Config Validation

- Schema-validated on load (fail fast with clear error messages)
- Credential refs validated (secrets exist)
- Persona capability references validated (no typos in capability labels)

**Acceptance Criteria:**
- AC-14.2.1: Invalid config produces a clear, actionable error message at startup
- AC-14.2.2: Missing required fields fail validation (not silently defaulted)
- AC-14.2.3: `agentctl reload` re-validates config before applying changes

---

## 15. Observability & Audit

### 15.1 Logging

- `pino` structured JSON logger
- Fields: `run_id`, `thread_id`, `persona`, `tool`, `request_id`
- Log levels: trace, debug, info, warn, error, fatal

### 15.2 Metrics

- Queue depth (pending, in-flight, dead-letter)
- Run duration (p50, p95, p99)
- Sandbox starts / active count
- Tool call counts by tool type
- Error rates by category
- Token usage per run (API key mode only)

### 15.3 Audit Log

Append-only `audit_log` table. Records:
- Every tool execution
- Every approval decision
- Every outbound channel send
- Every schedule trigger
- Every config reload

**Acceptance Criteria:**
- AC-15.1.1: All log lines are valid JSON with required correlation fields
- AC-15.3.1: Audit log entries are never deleted or modified
- AC-15.3.2: Every side-effecting operation has an audit log entry

---

## 16. Deployment

### 16.1 Modes

| Mode | Description |
|------|-------------|
| Native daemon | systemd service; sandboxes via local Docker |
| Containerized daemon | agentd in Docker; sandboxes via nested or sibling containers |
| Wake-only | systemd timer; process pending queue on wake |

### 16.2 systemd Integration

- `agentd.service` unit file
- Watchdog ping for liveness
- Health check via `agentctl status`
- Graceful shutdown on SIGTERM

### 16.3 Container Image

- Base: `node:22-slim`
- Pre-installed: Agent SDK runtime, skill loader
- No "install at runtime" — all dependencies baked in

**Acceptance Criteria:**
- AC-16.2.1: systemd service starts and stops cleanly
- AC-16.2.2: Watchdog detects hung daemon and triggers restart
- AC-16.3.1: Container image builds successfully and passes smoke test

---

## 17. Skills System

### 17.1 Skill Structure

```
skills/<skill_name>/
  skill.yaml          # metadata, required capabilities, config schema
  prompts/*.md        # persona augmentation fragments
  tools/*.yaml        # tool manifests (capability labels + schemas)
  mcp/*.json          # MCP server definitions (optional)
  migrations/*.sql    # DB migrations (optional)
```

### 17.2 Skill Lifecycle

- Install: copy skill directory + run migrations
- Enable: add to persona config
- Resolve: `persona.capabilities ∩ skill.requiredCapabilities` = granted
- Hot-reload: `agentctl reload` picks up skill changes for new runs

**Acceptance Criteria:**
- AC-17.2.1: Skills with unmet required capabilities produce a clear warning (not silent failure)
- AC-17.2.2: Skill migrations run in order during `agentctl migrate`
- AC-17.2.3: Enabling a skill for a persona takes effect on the next run (no container restart needed)

---

## 18. MCP Integration

- MCP servers run on the host (preferred) or in separate sandboxes
- agentd acts as a tool proxy: sandbox requests MCP call -> agentd checks policy -> forwards
- Each persona has an MCP allowlist
- Each MCP server has its own credential scope

**Acceptance Criteria:**
- AC-18.1: MCP tool calls are policy-checked identically to host/sandbox tools
- AC-18.2: MCP server failures do not crash agentd
- AC-18.3: MCP servers can be added/removed via config reload

---

## Appendix A: Recommended Defaults

| Setting | Default |
|---------|---------|
| Network in sandboxes | Off |
| RW mounts | `artifacts/` only |
| Channel sends | Require approval unless persona trusted |
| Container model | Warm per thread (persistent) |
| Idle container timeout | 30 minutes |
| Worker task retry limit | 3 |
| IPC poll interval | 500ms |
| Queue retry backoff | Exponential, base 1s, max 60s, jitter |
| Queue max attempts | 3 |
| Scheduler tick | 5 seconds |
| Tool execution timeout | 30 seconds |

---

## Appendix B: Token Usage Tracking

Tracked only when using Anthropic API keys (not subscription auth). Per-run:
- Input tokens, output tokens, cache read/write tokens
- Aggregated per persona, per thread, per time period
- Optional budget limits per persona (soft warning + hard cap)
